#!/bin/sh
set -eu

private_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/local/bin/php "$private_root/app/bin/collector-cycle.php"
