FROM python:3.11-slim

ARG TARGETARCH

# 基础工具 + Xvfb（两个架构都需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates curl \
    xvfb xdotool x11-utils \
    scrot python3-tk python3-dev \
    fluxbox \
  && rm -rf /var/lib/apt/lists/*

# amd64: Google Chrome（官方包，自带所有依赖）
# arm64: Chromium（Debian 官方包，同样自带所有依赖）
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get update \
      && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
         | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
         > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends chromium \
      && ln -sf /usr/bin/chromium /usr/bin/google-chrome \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN python -c "import seleniumbase; print('seleniumbase ready')" \
  && if [ "$TARGETARCH" = "amd64" ]; then \
       CHROME_MAJOR="$(google-chrome --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"; \
       echo "Installed Chrome major version: ${CHROME_MAJOR:-unknown}"; \
       if [ -n "$CHROME_MAJOR" ]; then \
         python -m seleniumbase get uc_driver --version="$CHROME_MAJOR" 2>/dev/null \
           || python -m seleniumbase get uc_driver 2>/dev/null || true; \
       else \
         python -m seleniumbase get uc_driver 2>/dev/null || true; \
       fi; \
     else \
       apt-get update \
       && apt-get install -y --no-install-recommends chromium-driver \
       && rm -rf /var/lib/apt/lists/* \
       && SB_DRIVERS=$(python -c "import os, seleniumbase; print(os.path.join(os.path.dirname(seleniumbase.__file__), 'drivers'))") \
       && cp /usr/bin/chromedriver "$SB_DRIVERS/uc_driver" \
       && chmod +x "$SB_DRIVERS/uc_driver"; \
     fi

COPY server.py .

ENV DISPLAY=:99
ENV PYTHONUNBUFFERED=1

EXPOSE 7317

ENTRYPOINT ["/bin/sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 && Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset & sleep 1 && fluxbox &>/dev/null & sleep 1 && exec python server.py"]
