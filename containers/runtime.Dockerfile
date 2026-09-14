ARG DOTNET_IMAGE
ARG NODE_IMAGE
FROM ${DOTNET_IMAGE} AS dotnet
FROM ${NODE_IMAGE}

COPY --from=dotnet /usr/share/dotnet /usr/share/dotnet
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium python3 ca-certificates git libgssapi-krb5-2 libicu72 libssl3 zlib1g \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

ENV DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_CLI_HOME=/tmp \
    HOME=/tmp \
    BENCH_BROWSER_EXECUTABLE=/usr/bin/chromium \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /work
USER 1000:1000
CMD ["node", "--version"]
