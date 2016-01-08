# tim-bank

Usage:
```bash
# see sample-conf for conf format
banks sample-conf/conf.json <options>
```

Example:
```bash
# start banks sequentially, don't write to blockchain, run only bank "rich"
banks sample-conf/conf.json -s -c false -b rich
```

Options:
```bash
-h, --help              print usage
-s, --seq               start banks sequentially
-c, --chain             whether to write to blockchain (default: true)
-b, --banks             banks to run (defaults to banks in conf that don\'t have run: false)
--public                expose the server to non-local requests
```
