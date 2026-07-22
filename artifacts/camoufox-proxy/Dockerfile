FROM python:3.11-slim-bookworm

# Camoufox is a patched Firefox. It needs the usual GTK/X libs + Xvfb for its
# "virtual" headful mode (headful-on-virtual-display is harder to detect than headless).
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libgtk-3-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2 libdbus-glib-1-2 libxt6 libpci3 fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download the Camoufox browser at build time so the first launch is instant and the
# container has no network dependency at runtime.
RUN python -m camoufox fetch

COPY server.py .

ENV PYTHONUNBUFFERED=1
ENV DISPLAY=:99
ENV PORT=7318
EXPOSE 7318

# Xvfb for Camoufox's "virtual" headful mode, then the launcher API.
ENTRYPOINT ["/bin/sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99; Xvfb :99 -screen 0 1920x1080x24 -ac & sleep 2 && exec python server.py"]
