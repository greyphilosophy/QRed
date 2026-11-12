export function solveLinearSystem(matrix, vector) {
  const size = matrix.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < size; i++) {
    let pivot = i;
    for (let j = i + 1; j < size; j++)
      if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-8) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const factor = 1 / a[i][i];
    for (let j = i; j <= size; j++) a[i][j] *= factor;
    for (let j = 0; j < size; j++) if (j !== i) {
      const f = a[j][i];
      for (let k = i; k <= size; k++) a[j][k] -= f * a[i][k];
    }
  }
  return a.map(row => row[size]);
}
