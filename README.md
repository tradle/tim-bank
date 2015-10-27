# tim-bank

*BANK SIMULATOR, DO NOT USE IN PRODUCTION*

Usage:
```bash
bank -i ./identity.json -k ./keys.json <options>
```

Example:
```bash
bank -i ./identity.json -k ./keys.json -p 12345 -t 54321
```

Options:
```bash
-h, --help              print usage
-i, --identity [path]   path to identity JSON [REQUIRED]
-k, --keys [path]       path to private keys file (for identity) [REQUIRED]
-p, --port [number]     server port (default: 33333)
-t, --tim-port [number] port tim will run on (default: 44444)
--public                expose the server to non-local requests
```
