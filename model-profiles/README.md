# Model-authored profiles

Profiles written by `define_model_profile` are stored here as one JSON file per
profile, named `<id>.json`. Each file is validated against the profile schema
when it is loaded, and a malformed file is reported by `list_model_profiles`
rather than being able to stop the server.

Built-in profiles live in `src/profiles/builtin.ts` and are always available;
a file here with the same id overrides the built-in.

See the "Model Profiles" section of the root README for the resolution order and
the full field list.
