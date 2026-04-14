---
name: google-places
description: Use Google Places tools efficiently. Prefer the fewest, cheapest calls that directly answer the user.
---

Tools:
- `google_places.search`
- `google_places.nearby`
- `google_places.details`

Use `google_places.search` for natural-language or address-based requests.
Use `google_places.nearby` only when latitude/longitude are already known.
Use `google_places.details` only after a prior search returns a `placeId`.

If you are prompted to find something near a person, attempt to use a tool like google_contacts to look up their address before using google_places tools, and search with that address. Otherwise, ask for an address if the location is too vague.

## Rules

- Start with one focused search.
- Keep `maxResults` small unless the user wants a long list.
- Use `minRating` when the user asks for highly rated places.
- Use `openNow` only if the user asks or it clearly matters.
- Only call `details` for the best candidate or shortlist.
- Do not repeat the same search unless the criteria changed.
- Do not make dummy or validation-style searches like `"coffee"` unless the user actually asked for coffee.

## Search patterns

Good:
- `google_places.search({ "query": "lunch restaurants near 10581 140 St., Surrey, BC", "type": "restaurant", "minRating": 4.5, "maxResults": 5 })`
- `google_places.search({ "query": "coffee shops near downtown Vancouver", "type": "cafe", "openNow": true, "maxResults": 5 })`
- `google_places.nearby({ "latitude": 49.2827, "longitude": -123.1207, "radius": 1000, "type": "restaurant", "maxResults": 5 })`

Avoid:
- broad searches without a location when one is known
- calling `details` for every result
- multiple lightly reworded searches
- any call that does not materially help answer the user

## Output

Summarize the best few options with:
- name
- address
- rating
- short reason it fits
- maps link when available
