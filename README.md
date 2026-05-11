# Three Intelligences Explorer

This directory contains the Three Intelligences Explorer demo.

Public demo: https://salmonofdoubt.github.io/demos/intelligence/

Model Logic page: https://salmonofdoubt.github.io/demos/intelligence/model.html

Archived release DOI: https://doi.org/10.5281/zenodo.19633908

The complete methodology, assumptions, data modes, indicator framework, equations, limitations, and APA 7 references are maintained on the Model Logic page.

Local test:

python3 -m http.server 8010

Then open:

http://localhost:8010/demos/intelligence/
http://localhost:8010/demos/intelligence/model.html

## Data route

The public demo uses this data route:

1. Local World Bank snapshot: `data/worldbank_snapshot.json`
2. Browser live fetch from the World Bank API, only if the snapshot is unavailable
3. Illustrative fallback CSV, only if neither snapshot nor live fetch is usable

The homepage displays data mode, update date, indicator source, and a small indicator health map. The full explanation is in `model.html`.
