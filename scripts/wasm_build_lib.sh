#!/usr/bin/env bash

set -euo pipefail

trap exit SIGINT

PROJECT_ROOT="$(cd $(dirname "$BASH_SOURCE[0]") && cd .. && pwd)" &> /dev/null

MODE=${1:-Fast}
FEATURES=${2:-mvp}
DUCKDB_LOCATION=${3:-"$PROJECT_ROOT/submodules/duckdb"}
echo "MODE=${MODE}"
echo "${DUCKDB_LOCATION}"

CPP_SOURCE_DIR="${PROJECT_ROOT}/lib"
DUCKDB_LIB_DIR="${PROJECT_ROOT}/packages/duckdb-wasm/src/bindings"

CORES=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu)

ADDITIONAL_FLAGS=
SUFFIX=
LINK_FLAGS=
case $MODE in
  "debug") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=Debug -DWASM_FAST_LINKING=1" ;;
  "dev") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=RelWithDebInfo -DWASM_FAST_LINKING=1" ;;
  "relsize") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=Release -DWASM_MIN_SIZE=1" ;;
  "relperf") ADDITIONAL_FLAGS="-DCMAKE_BUILD_TYPE=Release" ;;
   *) ;;
esac
case $FEATURES in
  "mvp")
    ADDITIONAL_FLAGS="${ADDITIONAL_FLAGS} -DDUCKDB_CUSTOM_PLATFORM=wasm_mvp -DDUCKDB_EXPLICIT_PLATFORM=wasm_mvp"
    SUFFIX="-mvp"
    ;;
  "eh")
    ADDITIONAL_FLAGS="${ADDITIONAL_FLAGS} -DWITH_WASM_EXCEPTIONS=1 -DDUCKDB_CUSTOM_PLATFORM=wasm_eh -DDUCKDB_EXPLICIT_PLATFORM=wasm_eh"
    SUFFIX="-eh"
    ;;
  "coi")
    ADDITIONAL_FLAGS="${ADDITIONAL_FLAGS} -DWITH_WASM_EXCEPTIONS=1 -DWITH_WASM_THREADS=1 -DWITH_WASM_SIMD=1 -DWITH_WASM_BULK_MEMORY=1 -DDUCKDB_CUSTOM_PLATFORM=wasm_threads -DDUCKDB_EXPLICIT_PLATFORM=wasm_threads"
    SUFFIX="-coi"
    LINK_FLAGS="-pthread -sSHARED_MEMORY=1"
    ;;
   *) ;;
esac
echo "MODE=${MODE}"
echo "FEATURES=${FEATURES}"

BUILD_DIR="${PROJECT_ROOT}/build/${MODE}/${FEATURES}"
mkdir -p ${BUILD_DIR}

set -x

DUCKDB_WASM_VERSION_NAME=${DUCKDB_WASM_VERSION:-unknown}

# DuckDB 2 alpha's browser initialization exhausted the four-worker Emscripten
# pool before SQL ran. A 32-worker pool proved too expensive to initialize in
# Chrome (all workers stayed live while loading). Keep a bounded eight-worker
# pool: enough headroom for the smoke's threads=4 plus async/background work,
# while still failing deterministically on genuine exhaustion. This applies
# ONLY to the experimental COI build and refuses unexpected CMake input.
if [ "${FEATURES}" = "coi" ]; then
  python3 - "${CPP_SOURCE_DIR}/CMakeLists.txt" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
old = '-sPTHREAD_POOL_SIZE=4 -pthread'
new = '-sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=2 -pthread'
if source.count(old) != 1:
    raise SystemExit(f'Expected exactly one original COI pthread pool flag, found {source.count(old)}')
path.write_text(source.replace(old, new))
print('COI pthread pool: 8 preallocated workers, strict exhaustion enabled')
PY
fi

emcmake cmake \
    -S${CPP_SOURCE_DIR} \
    -B${BUILD_DIR} \
    -DDUCKDB_WASM_VERSION=${DUCKDB_WASM_VERSION_NAME} \
    -DCMAKE_C_COMPILER_LAUNCHER=ccache \
    -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
    -DDUCKDB_LOCATION=${DUCKDB_LOCATION} \
    -DWASM_LINK_FLAGS_EXT="${LINK_FLAGS}" \
    -DDUCKDB_EXTENSION_CONFIGS=extension_config_wasm.cmake \
    ${ADDITIONAL_FLAGS}

emmake make \
    -C${BUILD_DIR} \
    -j${CORES} \
    duckdb_wasm

if [ "${USE_GENERATED_EXPORTED_LIST:-no}" == "yes" ]; then
make TARGET=${FEATURES} update_exported_list

emcmake cmake \
    -S${CPP_SOURCE_DIR} \
    -B${BUILD_DIR} \
    -DDUCKDB_WASM_VERSION=${DUCKDB_WASM_VERSION_NAME} \
    -DCMAKE_C_COMPILER_LAUNCHER=ccache \
    -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
    -DDUCKDB_LOCATION=${DUCKDB_LOCATION} \
    -DWASM_LINK_FLAGS_EXT="${LINK_FLAGS}" \
    -DDUCKDB_EXTENSION_CONFIGS=extension_config_wasm.cmake \
    -DUSE_GENERATED_EXPORTED_LIST=1 \
    ${ADDITIONAL_FLAGS}

emmake make \
    -C${BUILD_DIR} \
    -j${CORES} \
    duckdb_wasm
fi

js-beautify -v || npm install -g js-beautify
js-beautify ${BUILD_DIR}/duckdb_wasm.js > ${BUILD_DIR}/beauty.js
sed 's/case "__table_base"/case "getTempRet0": return getTempRet0;   case "__table_base"/g' ${BUILD_DIR}/beauty.js > ${BUILD_DIR}/beauty_sed.js
cp ${BUILD_DIR}/beauty_sed.js ${BUILD_DIR}/beauty.js
cp ${BUILD_DIR}/beauty.js ${BUILD_DIR}/duckdb_wasm.js
awk '{gsub(/get\(stubs, prop\) \{/,"get(stubs,prop) { if (prop.startsWith(\"invoke_\")) {return createDyncallWrapper(prop.substring(7));}"); print}' ${BUILD_DIR}/beauty.js > ${BUILD_DIR}/beauty2.js

# Preserve all Emscripten-generated WASM export bindings. The old awk filter
# removed every `var ... = wasmExports[...]` declaration except a small
# allowlist, including the binding of `f` inside createExportWrapper and
# `___trap`. That produced three non-empty artifacts but a runtime that
# immediately crashed with ReferenceError: f is not defined. Removing these
# declarations is not a safe size optimization.
cp ${BUILD_DIR}/beauty2.js ${BUILD_DIR}/duckdb_wasm.js

if [ "${FEATURES}" = "coi" ]; then
  grep -Eq 'var pthreadPoolSize = 8;' "${BUILD_DIR}/duckdb_wasm.js" || {
    echo 'ERROR: generated COI JS does not contain the 8-worker preallocated pthread pool' >&2
    exit 1
  }
fi

cp ${BUILD_DIR}/duckdb_wasm.wasm ${DUCKDB_LIB_DIR}/duckdb${SUFFIX}.wasm
sed \
  -e "s/duckdb_wasm\.wasm/.\/duckdb${SUFFIX}.wasm/g" \
  ${BUILD_DIR}/duckdb_wasm.js > ${DUCKDB_LIB_DIR}/duckdb${SUFFIX}.js

if [ -f ${BUILD_DIR}/duckdb_wasm.worker.js ]; then
  sed \
    -e "s/duckdb_wasm\.wasm/.\/duckdb${SUFFIX}.wasm/g" \
    -e "s/duckdb_wasm\.js/.\/duckdb${SUFFIX}.js/g" \
    ${BUILD_DIR}/duckdb_wasm.worker.js > ${DUCKDB_LIB_DIR}/duckdb${SUFFIX}.pthread.js

  # Expose the module.
  # This will allow us to reuse the generated pthread handler and only overwrite the loading.
  # More info: duckdb-browser-async-coi.pthread.worker.ts
  printf "\nexport const onmessage = self.onmessage;\nexport function getModule() { return Module; }\nexport function setModule(m) { Module = m; }\n" \
    >> ${DUCKDB_LIB_DIR}/duckdb${SUFFIX}.pthread.js
fi
