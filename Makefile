.PHONY: install run tests demo build clean

install:
	pip install -r requirements.txt

run:
	uvicorn backend.app:create_app --factory --host 0.0.0.0 --port 8190 --reload

tests:
	python -m pytest tests/test_qred.py -v

demo:
	bash demo.sh

build:
	cd frontend && npm install && npm run build

clean:
	find . -type d -name '__pycache__' -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete
	rm -rf .pytest_cache frontend/node_modules frontend/dist