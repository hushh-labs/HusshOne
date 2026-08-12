# syntax=docker/dockerfile:1.7
FROM python:3.13-slim@sha256:ffb752e139c0a19692a43af8d8523b274222dd68eebad5d583b45c2201c6e30a AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

RUN addgroup --system app && adduser --system --ingroup app --home /app app
WORKDIR /app

COPY pyproject.toml README.md requirements.runtime.lock ./
RUN python -m pip install --require-hashes -r requirements.runtime.lock
COPY app ./app
COPY data ./data
RUN python -m pip install --no-deps .

USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
