# Image for the PHP proxy smoke test on machines without php:
#   docker build -t websh-php-smoke tests/php
FROM php:8.3-cli
RUN apt-get update -qq && apt-get install -y -qq python3 curl >/dev/null && rm -rf /var/lib/apt/lists/*
