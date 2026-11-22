#!/bin/sh
set -eu
: "${HARNESS2_PYTHON:?Set HARNESS2_PYTHON to the isolated Python with coverage 7.10.7}"
"$HARNESS2_PYTHON" -m coverage run --rcfile=harness2/.coveragerc harness2/test_pilot.py
"$HARNESS2_PYTHON" -m coverage report --rcfile=harness2/.coveragerc
