FROM python:3.11-slim
WORKDIR /service
COPY cloud_api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY cloud_api ./cloud_api
RUN mkdir app && touch app/__init__.py
# Only query contracts/models are included; no dashboard, workers or credentials.
COPY app/business_lookup.py app/config.py app/database.py app/models.py ./app/
RUN useradd --uid 10001 --create-home api
USER api
ENV PYTHONUNBUFFERED=1
CMD ["sh", "-c", "exec uvicorn cloud_api.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
