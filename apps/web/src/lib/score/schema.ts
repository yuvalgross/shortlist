// The exact shape the matching model must return when scoring one job.
// Every field is required (empty string, 0, false or an empty list when absent) to keep the schema strict.
// Points are never decided by the model: it returns labels with quotes, and code turns them into points.

type Prop = { readonly type: "string" | "number" | "integer" | "boolean"; readonly enum?: readonly string[] };
const quoted = <E extends Record<string, Prop>>(extra: E) => ({
  type: "object" as const,
  properties: { ...extra, quote: { type: "string" as const } },
  required: [...Object.keys(extra), "quote"],
  additionalProperties: false as const,
});

const reasonList = {
  type: "array",
  items: {
    type: "object",
    properties: { point: { type: "string" }, quote: { type: "string" } },
    required: ["point", "quote"],
    additionalProperties: false,
  },
} as const;

export const jobScoreSchema = {
  type: "object",
  properties: {
    company: { type: "string" },
    title: { type: "string" },
    location_text: { type: "string" },
    remote_type: { type: "string", enum: ["onsite", "hybrid", "remote", "unknown"] },
    salary: quoted({
      stated: { type: "boolean" },
      min: { type: "number" },
      max: { type: "number" },
      currency: { type: "string" },
      period: { type: "string", enum: ["year", "month", "hour", "none"] as const },
      is_ote: { type: "boolean" },
    }),
    headcount: quoted({ stated: { type: "boolean" }, value: { type: "integer" } }),
    summary: { type: "string" },
    plus: reasonList,
    minus: reasonList,
    role_fit: { type: "number" },
    location: quoted({ rule: { type: "integer" }, reason: { type: "string" } }),
    languages_required: {
      type: "array",
      items: {
        type: "object",
        properties: { language: { type: "string" }, quote: { type: "string" } },
        required: ["language", "quote"],
        additionalProperties: false,
      },
    },
    role_shape: quoted({ value: { type: "string", enum: ["build", "ops_titled", "other"] as const } }),
    sales_ops: quoted({ applies: { type: "boolean" } }),
    run_and_report: quoted({ applies: { type: "boolean" } }),
    ops_years_gap: quoted({ applies: { type: "boolean" }, years: { type: "integer" } }),
  },
  required: [
    "company", "title", "location_text", "remote_type", "salary", "headcount", "summary", "plus", "minus",
    "role_fit", "location", "languages_required", "role_shape", "sales_ops", "run_and_report", "ops_years_gap",
  ],
  additionalProperties: false,
} as const;

type Quoted<T> = T & { quote: string };
export type Reason = { point: string; quote: string };

export type RawScore = {
  company: string;
  title: string;
  location_text: string;
  remote_type: "onsite" | "hybrid" | "remote" | "unknown";
  salary: Quoted<{ stated: boolean; min: number; max: number; currency: string; period: "year" | "month" | "hour" | "none"; is_ote: boolean }>;
  headcount: Quoted<{ stated: boolean; value: number }>;
  summary: string;
  plus: Reason[];
  minus: Reason[];
  role_fit: number;
  location: Quoted<{ rule: number; reason: string }>;
  languages_required: { language: string; quote: string }[];
  role_shape: Quoted<{ value: "build" | "ops_titled" | "other" }>;
  sales_ops: Quoted<{ applies: boolean }>;
  run_and_report: Quoted<{ applies: boolean }>;
  ops_years_gap: Quoted<{ applies: boolean; years: number }>;
};
