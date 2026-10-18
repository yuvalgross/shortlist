// The exact shape the matching model must return when reading a CV.
// Every field is required (empty string or empty list when absent) to keep the schema simple and strict.

export const cvParseSchema = {
  type: "object",
  properties: {
    full_name: { type: "string" },
    headline: { type: "string" },
    location: { type: "string" },
    phone: { type: "string" },
    email: { type: "string" },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, url: { type: "string" } },
        required: ["label", "url"],
        additionalProperties: false,
      },
    },
    languages: {
      type: "array",
      items: {
        type: "object",
        properties: { language: { type: "string" }, level: { type: "string" } },
        required: ["language", "level"],
        additionalProperties: false,
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: { school: { type: "string" }, degree: { type: "string" }, year: { type: "string" } },
        required: ["school", "degree", "year"],
        additionalProperties: false,
      },
    },
    certifications: { type: "string" },
    experiences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          company_desc: { type: "string" },
          location: { type: "string" },
          work_mode: { type: "string", enum: ["onsite", "hybrid", "remote", "unknown"] },
          employment_type: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          header_quote: { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                metric: { type: "string" },
                quote: { type: "string" },
              },
              required: ["label", "metric", "quote"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "title", "company", "company_desc", "location", "work_mode", "employment_type",
          "start", "end", "header_quote", "results",
        ],
        additionalProperties: false,
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: ["tool", "method", "domain", "other"] },
          quote: { type: "string" },
        },
        required: ["name", "category", "quote"],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["skill", "title"] },
          name: { type: "string" },
          category: { type: "string", enum: ["tool", "method", "domain", "other"] },
          experience_index: { type: "integer" },
          ats_title: { type: "string" },
          reason: { type: "string" },
          quote: { type: "string" },
        },
        required: ["kind", "name", "category", "experience_index", "ats_title", "reason", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "full_name", "headline", "location", "phone", "email", "links", "languages", "education",
    "certifications", "experiences", "skills", "suggestions",
  ],
  additionalProperties: false,
} as const;

export type RawResult = { label: string; metric: string; quote: string };
export type RawExperience = {
  title: string; company: string; company_desc: string; location: string;
  work_mode: "onsite" | "hybrid" | "remote" | "unknown"; employment_type: string;
  start: string; end: string; header_quote: string; results: RawResult[];
};
export type RawSkill = { name: string; category: "tool" | "method" | "domain" | "other"; quote: string };
export type RawSuggestion = {
  kind: "skill" | "title"; name: string; category: RawSkill["category"]; experience_index: number;
  ats_title: string; reason: string; quote: string;
};
export type RawParse = {
  full_name: string; headline: string; location: string; phone: string; email: string;
  links: { label: string; url: string }[];
  languages: { language: string; level: string }[];
  education: { school: string; degree: string; year: string }[];
  certifications: string;
  experiences: RawExperience[];
  skills: RawSkill[];
  suggestions: RawSuggestion[];
};
