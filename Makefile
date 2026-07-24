.PHONY: install install-frontend run tests demo build clean lint

# ---- Frontend ----

install install-frontend:
	cd frontend && npm ci

build:
	cd frontend && npm ci && npm run build

lint:
	cd frontend && npm run lint

run:
	cd frontend && npm start

tests:
	cd frontend && npm test

clean:
	find . -type d -name '__pycache__' -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete
	rm -rf .pytest_cache frontend/node_modules frontend/build frontend/dist

demo:
	@echo "QRed is fully client-side — no backend server needed."
	@echo "Running the dev server..."
	cd frontend && npm start