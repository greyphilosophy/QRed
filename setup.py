from setuptools import setup, find_packages

setup(
    name="qred",
    version="0.1.0",
    description="Tamper-evident document sealing and verification",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=[
        "fastapi>=0.110,<1.0",
        "pydantic>=2.0,<3.0",
        "uvicorn>=0.30,<1.0",
        "cryptography>=42.0",
        "pymupdf>=1.27.0",
        "qrcode>=8.0",
        "Pillow>=10.0",
        "python-multipart>=0.0.9",
        "pytest>=8.0",
        "httpx>=0.27",
        "b45 @ git+https://github.com/greyphilosophy/b45.git@338ffcaec502b73a66d01948a7dbe4049a4ed783",
    ],
    entry_points={
        "console_scripts": [
            "qred=backend.app:create_app",
        ],
    },
)
