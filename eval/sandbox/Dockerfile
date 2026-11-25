# Code-sandbox arm: model-written Python runs here with no network (see eval/run.mjs).
FROM python:3.12-slim
RUN pip install --no-cache-dir pandas==2.2.3 numpy==2.1.3 numpy-financial==1.0.0 \
 && useradd -m runner
USER runner
WORKDIR /home/runner
