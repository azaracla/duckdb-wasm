#!/usr/bin/env python3
"""Bound DuckDB 2 async I/O threads before the WASM database starts.

The DuckLake browser smoke previously executed SET async_threads=1 after
WebDB::Open(), but the default async workers were already spawned by then.
An Emscripten pool of 8 and even 16 reported exhaustion during db.open().
Apply the cap before DuckDB() construction to prevent the startup oversubscription.
This patch is deliberately limited to the experimental loadable COI build.
"""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / 'lib/src/webdb.cc'
OLD = '''        db_config.options.maximum_threads = config_->maximum_threads;
        db_config.options.use_temporary_directory = false;'''
NEW = '''        db_config.options.maximum_threads = config_->maximum_threads;
        // Cap async I/O threads before DuckDB initialization: setting this via
        // SQL after db.open() does not undo already-created Emscripten pthreads.
        // Keep the cap independent of CPU threads to preserve parallel I/O.
        db_config.SetOptionByName("async_threads", Value::BIGINT(2));
        db_config.options.use_temporary_directory = false;'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    source = PATH.read_text()
    old_count = source.count(OLD)
    new_count = source.count(NEW)
    if old_count == 1 and new_count == 0:
        if args.check:
            parser.error('Pre-open async thread cap is missing; run --apply first')
        PATH.write_text(source.replace(OLD, NEW, 1))
    elif old_count == 0 and new_count == 1:
        pass
    else:
        parser.error(f'Unexpected WebDB::Open signature: original={old_count}, patched={new_count}')
    if PATH.read_text().count(NEW) != 1:
        raise RuntimeError('Pre-open async thread cap verification failed')
    print('PASS: loadable DuckDB WASM caps async_threads=2 before database construction')

if __name__ == '__main__':
    main()
