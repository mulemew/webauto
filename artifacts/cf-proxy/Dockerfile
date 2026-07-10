FROM python:3.11-slim-bookworm

ARG TARGETARCH

# 基础工具 + Xvfb（两个架构都需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates curl \
    xvfb xdotool x11-utils \
    scrot python3-tk python3-dev \
    fluxbox \
    ffmpeg \
    fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
  && rm -rf /var/lib/apt/lists/*
# fonts-liberation / carlito / caladea are free, metric-compatible substitutes
# for Arial/Times New Roman/Courier New / Calibri / Cambria — so a Windows
# fingerprint (FINGERPRINT_OS=windows) passes width-based font detection.

# Create the runtime user before installing SeleniumBase so root can prepare
# driver/cache permissions explicitly. UC mode executes and may patch
# seleniumbase/drivers/uc_driver at runtime; leaving that root-owned after
# switching USER app produces:
#   PermissionError: ... seleniumbase/drivers/uc_driver
RUN useradd -m -u 1000 app

# amd64: Google Chrome（官方包，自带所有依赖）
# arm64: Chromium（Debian 官方包，同样自带所有依赖）
#
# Docker BuildKit sets TARGETARCH, but plain `docker compose build` may leave it
# empty. If we only check TARGETARCH, amd64 local builds accidentally fall into
# the arm64/Chromium branch. SeleniumBase UC is substantially more reliable with
# Google Chrome than Debian Chromium on amd64, so infer the real dpkg arch when
# TARGETARCH is unavailable.
RUN ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then \
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
  && ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then \
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
     fi \
  && SB_DRIVERS="$(python -c 'import os, seleniumbase; print(os.path.join(os.path.dirname(seleniumbase.__file__), "drivers"))')" \
  && chmod -R a+rX "$SB_DRIVERS" \
  && find "$SB_DRIVERS" -maxdepth 1 -type f -name '*driver*' -exec chmod a+rx {} + \
  && chown -R app:app "$SB_DRIVERS" /home/app

COPY server.py .

# Run as a non-root user so Chrome/Chromium can launch without --no-sandbox.
# Recent SeleniumBase UC-mode paths strip or override --no-sandbox from
# chromium_arg, which caused Chrome to crash on root ("Running as root
# without --no-sandbox is not supported") and made uc_driver report
# "session not created: cannot connect to chrome". Switching to a normal
# user sidesteps the sandbox restriction entirely.
RUN mkdir -p /tmp/.X11-unix /tmp/cf-proxy-logs \
    && chown -R app:app /app /tmp/.X11-unix /tmp/cf-proxy-logs

USER app

ENV DISPLAY=:99
ENV PYTHONUNBUFFERED=1
ENV HOME=/home/app
# faster-whisper model used by the reCAPTCHA audio solver. "small" (int8) is a
# good speed/accuracy balance on a few CPU cores; override to "base"/"tiny" for
# lower RAM or "medium" for higher accuracy.
ENV WHISPER_MODEL=small

# Pre-download the Whisper model at build time (as the app user so the
# ~/.cache/huggingface copy is readable at runtime). `|| true` so a transient
# Hugging Face outage doesn't fail the build — it will lazy-download on first use.
RUN python -c "from faster_whisper import WhisperModel; import os; WhisperModel(os.getenv('WHISPER_MODEL','small'), device='cpu', compute_type='int8')" || true

EXPOSE 7317

ENTRYPOINT ["/bin/sh", "-c", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 && Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset & sleep 1 && fluxbox &>/dev/null & sleep 1 && exec python server.py"]
