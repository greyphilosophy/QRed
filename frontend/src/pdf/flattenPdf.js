import {
  AnnotationFlags, PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown,
  PDFName, PDFObjectCopier, PDFRadioGroup, PDFRef, PDFStream, PDFTextField,
  drawObject,
} from "pdf-lib";

const name = PDFName.of;
const normalizedText = (value) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
const cannotFlatten = (reason) => new Error(`Cannot safely flatten this PDF: ${reason}. Export or print it to a text PDF, check every value, and try again.`);

function expectedText(field) {
  if (field instanceof PDFTextField) {
    if (field.isPassword() || field.isFileSelector() || field.isRichFormatted()) {
      throw cannotFlatten(`field "${field.getName()}" uses an unsupported text format`);
    }
    return field.getText() || "";
  }
  if (field instanceof PDFDropdown) {
    const selected = field.getSelected();
    if (selected.length > 1) throw cannotFlatten("a dropdown has multiple selected values");
    const value = selected[0] || "";
    const option = field.acroField.getOptions().find((item) => item.value.decodeText() === value);
    return option ? (option.display || option.value).decodeText() : value;
  }
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) return null;
  throw cannotFlatten(`field "${field.getName()}" has an unsupported field type`);
}

function normalAppearance(pdf, field, widget) {
  let appearance = widget.getNormalAppearance();
  if (appearance instanceof PDFDict && (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) {
    const value = field.acroField.getValue();
    const state = appearance.has(value) ? value : name("Off");
    if (widget.getAppearanceState() !== state) {
      throw cannotFlatten(`field "${field.getName()}" has an inconsistent selection appearance`);
    }
    appearance = appearance.get(state);
  }
  if (!(appearance instanceof PDFRef) || !(pdf.context.lookup(appearance) instanceof PDFStream)) {
    throw cannotFlatten(`field "${field.getName()}" has no usable appearance`);
  }
  return appearance;
}

function checkWidgetGeometry(pdf, widget, appearance) {
  const { width, height } = widget.getRectangle();
  const stream = pdf.context.lookup(appearance, PDFStream);
  const bbox = stream.dict.lookup(name("BBox"), PDFArray).asArray().map((item) => item.asNumber());
  const matrix = stream.dict.lookupMaybe(name("Matrix"), PDFArray)?.asArray().map((item) => item.asNumber()) || [1, 0, 0, 1, 0, 0];
  const [a, b, c, d, e, f] = matrix;
  const points = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const actual = [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y))];
  // pdf-lib's flattener translates appearances into the widget rectangle; it
  // does not rescale their BBox. Reject geometry that would change on flattening.
  if (!(width > 0 && height > 0) || actual.some((value, i) => !Number.isFinite(value) || Math.abs(value - [0, 0, width, height][i]) > 0.01)) {
    throw cannotFlatten("a form field has unsupported appearance geometry");
  }
  return [width, height];
}

export async function flattenPdfForSealing(file) {
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const acroForm = pdf.catalog.lookupMaybe(name("AcroForm"), PDFDict);
  // getForm() silently deletes XFA; check before calling it.
  if (acroForm?.has(name("XFA"))) throw cannotFlatten("XFA forms are not supported");
  const form = acroForm ? pdf.getForm() : null;
  const fields = form?.getFields() || [];
  const widgets = new Map();
  for (const field of fields) {
    const text = expectedText(field);
    const fieldWidgets = field.acroField.getWidgets();
    if (!fieldWidgets.length) throw cannotFlatten(`field "${field.getName()}" has no visible widget`);
    for (const widget of fieldWidgets) {
      if (widget.getFlags() & (AnnotationFlags.Hidden | AnnotationFlags.Invisible | AnnotationFlags.NoView | AnnotationFlags.ToggleNoView | AnnotationFlags.NoZoom | AnnotationFlags.NoRotate)) {
        throw cannotFlatten(`field "${field.getName()}" uses unsupported visibility or rotation settings`);
      }
      widgets.set(widget.dict, { field, widget, text });
    }
  }
  const pageWidgets = [];
  const seen = new Set();
  for (const page of pdf.getPages()) {
    const rectangles = [];
    for (const ref of page.node.Annots()?.asArray() || []) {
      const annotation = pdf.context.lookup(ref);
      if (!(annotation instanceof PDFDict) || annotation.get(name("Subtype")) !== name("Widget")) continue;
      if (!widgets.has(annotation) || seen.has(annotation)) throw cannotFlatten("an orphaned or duplicated form widget was found");
      const { widget } = widgets.get(annotation);
      if (widget.P() && widget.P() !== page.ref) throw cannotFlatten("a form widget points to a different page");
      const rect = widget.getRectangle();
      // The library flattens in field order, which can differ from annotation
      // stacking order. Overlapping widgets must not silently change appearance.
      if (rectangles.some((other) => rect.x < other.x + other.width && rect.x + rect.width > other.x && rect.y < other.y + other.height && rect.y + rect.height > other.y)) {
        throw cannotFlatten("overlapping form fields cannot be flattened without a visual review");
      }
      rectangles.push(rect);
      seen.add(annotation);
      pageWidgets.push({ page, ref });
    }
  }
  if (seen.size !== widgets.size) throw cannotFlatten("a form field is missing from its page");
  if (!fields.length) return { file, flattenedFieldCount: 0 };

  try {
    // Preserve existing fonts/appearances, including Unicode. Generate missing
    // appearances only; unsupported characters then fail instead of vanishing.
    form.updateFieldAppearances();
    await pdf.flush();
    for (const field of fields) {
      if (!(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) continue;
      const value = field.acroField.getValue();
      if (value !== name("Off") && !field.acroField.getWidgets().some((widget) => widget.getAppearances()?.normal instanceof PDFDict && widget.getAppearances().normal.has(value))) {
        throw cannotFlatten(`field "${field.getName()}" has no appearance for its selected value`);
      }
    }
    const appearances = await PDFDocument.create();
    const copier = PDFObjectCopier.for(pdf.context, appearances.context);
    const checks = [];
    for (const { field, widget, text } of widgets.values()) {
      const appearance = normalAppearance(pdf, field, widget);
      const size = checkWidgetGeometry(pdf, widget, appearance);
      if (text === null) continue; // Checkbox/radio marks remain graphics, outside the text signature.
      const page = appearances.addPage(size);
      page.pushOperators(drawObject(page.node.newXObject("Field", copier.copy(appearance))));
      checks.push({ field, text });
    }
    if (checks.length) {
      const { extractPdfPageTexts } = await import("./readPdfText.js");
      const texts = await extractPdfPageTexts(new Blob([await appearances.save()], { type: "application/pdf" }));
      checks.forEach(({ field, text }, index) => {
        if (normalizedText(texts[index]) !== normalizedText(text)) {
          throw cannotFlatten(`field "${field.getName()}" has a saved appearance that does not match its value`);
        }
      });
    }
    form.flatten({ updateFieldAppearances: false });
    // pdf-lib can leave deleted widget references in Annots. Remove exactly
    // the widgets we validated, preserving unrelated annotation references.
    for (const { page, ref } of pageWidgets) page.node.removeAnnot(ref);
    pdf.catalog.delete(name("AcroForm"));
    return {
      file: new Blob([await pdf.save({ updateFieldAppearances: false })], { type: "application/pdf" }),
      flattenedFieldCount: fields.length,
    };
  } catch (error) {
    if (error.message.startsWith("Cannot safely flatten")) throw error;
    throw cannotFlatten(`form appearance conversion failed (${error.message})`);
  }
}
