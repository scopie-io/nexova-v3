# templates/

Put each React e-commerce template in its own folder here, for example:

```
templates/
  nexova-starter/      reference implementation (keep it; it documents the contract)
  aurora-fashion/
  bloom-beauty/
  ...
```

Every template folder needs a `nexova.template.json` manifest and must follow `docs/TEMPLATE_CONTRACT.md`. Folders starting with `_` or `.` are ignored. The engine installs a template's dependencies on first use and reuses them for every store built from it.

Check discovery with:

```bash
node packages/engine/dist/cli.js templates
```
