FROM python:3.12-slim

WORKDIR /app

# Create non-root user matching the standard first-user UID on Linux/macOS hosts.
# Lets the named `spotifu-cache` volume be writable without chown on every boot.
RUN groupadd -g 1000 spotifu \
 && useradd -u 1000 -g 1000 -m -s /bin/bash spotifu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chown -R spotifu:spotifu /app

USER spotifu

EXPOSE 1985

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "1985"]
