# Version verified in PyPI + Microsoft MCR. Keep requirements-runner.txt in sync.
FROM mcr.microsoft.com/playwright/python:v1.64.1-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify openbox x11-utils tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-runner.txt /app/
RUN pip install --no-cache-dir -r requirements-runner.txt
COPY --chown=pwuser:pwuser runner /app/runner
COPY --chown=pwuser:pwuser extension /app/extension
COPY --chown=pwuser:pwuser deploy/entrypoint.sh /app/deploy/entrypoint.sh
RUN sed -i 's/\r$//' /app/deploy/entrypoint.sh \
    && chmod 755 /app/deploy/entrypoint.sh \
    && mkdir -p /app/data && chown pwuser:pwuser /app/data
USER pwuser
ENV DISPLAY=:99 BOT_DATA_DIR=/app/data PYTHONUNBUFFERED=1
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/app/deploy/entrypoint.sh"]
