FROM emscripten/emsdk:3.1.57 AS builder

ARG DUCKDB_REF=43f897e5f3446bde2b36cef5dc137eea14211fd9
ARG DUCKDB_SOURCE_ID=43f897e5f3
ARG DUCKLAKE_REF=eb7b95df82fc3ba0ace777e34ef1c81280477042
ARG VCPKG_REF=84bab45d415d22042bd0b9081aea57f362da3f35
ARG WASM_BUILD_JOBS=4

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends cmake git make ninja-build pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Build DuckLake from the candidate source, but against the exact DuckDB 2
# revision used by the COI runtime. Never trust DuckLake's own duckdb-version
# for this experiment: extension/runtime source ids must match exactly.
RUN git clone --filter=blob:none https://github.com/duckdb/ducklake.git ducklake \
    && git -C ducklake checkout --detach "$DUCKLAKE_REF" \
    && git -C ducklake submodule update --init extension-ci-tools duckdb \
    && git -C ducklake/duckdb fetch --depth 1 origin "$DUCKDB_REF" \
    && git -C ducklake/duckdb checkout --detach FETCH_HEAD \
    && echo "DuckLake $(git -C ducklake rev-parse HEAD)" \
    && echo "DuckDB   $(git -C ducklake/duckdb rev-parse HEAD)"

# The pinned DuckDB snapshot carries the compatibility patchset expected by its
# native APPLY_PATCHES build. Apply that exact patchset before attempting WASM.
RUN cd /src/ducklake \
    && python3 duckdb/scripts/apply_extension_patches.py duckdb/.github/patches/extensions/ducklake/

# Diagnostic ONLY: trace catalog/init and bypass the hanging secrets preload.
# This side module MUST NOT be distributed as a normal DuckLake binary.
COPY instrument_initializer.py /tmp/instrument_initializer.py
COPY instrument_catalog.py /tmp/instrument_catalog.py
COPY skip_secrets_probe.py /tmp/skip_secrets_probe.py
RUN python3 /tmp/instrument_initializer.py \
    && python3 /tmp/instrument_catalog.py \
    && python3 /tmp/skip_secrets_probe.py

RUN git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg \
    && git -C /opt/vcpkg checkout --detach "$VCPKG_REF" \
    && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics

ENV VCPKG_TOOLCHAIN_PATH=/opt/vcpkg/scripts/buildsystems/vcpkg.cmake \
    VCPKG_TARGET_TRIPLET=wasm32-emscripten \
    USE_MERGED_VCPKG_MANIFEST=1

# wasm_threads configures pthread compilation. USE_WASM_THREADS makes the side
# module compatible with shared-memory COI runtimes. Force the same DuckDB
# source id used by the runtime to avoid variable-length git abbreviation drift.
RUN cd /src/ducklake \
    && make -j"${WASM_BUILD_JOBS}" wasm_threads \
       COMMON_CMAKE_VARS="-DGIT_COMMIT_HASH=${DUCKDB_SOURCE_ID}" \
       EXT_FLAGS="-DUSE_WASM_THREADS=1 -DCMAKE_VERBOSE_MAKEFILE=ON"

RUN artifact="$(find /src/ducklake/build/wasm_threads -type f -name 'ducklake.duckdb_extension.wasm' -print -quit)" \
    && test -n "$artifact" \
    && echo "DuckLake WASM artifact: $artifact" \
    && mkdir -p /out \
    && cp "$artifact" /out/ducklake.duckdb_extension.wasm \
    && printf '%s\n' \
       "duckdb_ref=${DUCKDB_REF}" \
       "duckdb_source_id=${DUCKDB_SOURCE_ID}" \
       "ducklake_ref=${DUCKLAKE_REF}" \
       "emscripten=3.1.57" \
       "diagnostic_skip_duckdb_secrets=true" \
       > /out/build-manifest.txt

FROM scratch AS artifact
COPY --from=builder /out/ /
