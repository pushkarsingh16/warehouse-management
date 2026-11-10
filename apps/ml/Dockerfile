FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
COPY . .
RUN useradd --uid 10001 --create-home ml && mkdir /models && chown ml:ml /models
USER ml
ENV MODEL_DIR=/models TZ=UTC
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
