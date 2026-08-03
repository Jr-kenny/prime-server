# Scripts

This directory will contain local network startup, provider orchestration, Coston2 deployment, and reproducible demo commands.

The current provider harness is available through:

```bash
node scripts/providers.mjs start
node scripts/providers.mjs status
node scripts/providers.mjs stop
```

It starts four separate Node processes with separate ports and data directories.
