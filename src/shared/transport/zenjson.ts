import {
  createRestore,
  createSanitize,
  defaultTypes,
  type ICustomType,
  type restore as zenjsonRestore,
  type sanitize as zenjsonSanitize,
} from "@dldc/zenjson";

const zonedDateTimeTypes: ICustomType<Temporal.ZonedDateTime, string> = {
  name: "zonedDateTime",
  check: (val) => val instanceof Temporal.ZonedDateTime,
  restore: (str) => Temporal.ZonedDateTime.from(str),
  sanitize: (val) => val.toString(),
};

const plainDateTypes: ICustomType<Temporal.PlainDate, string> = {
  name: "plainDate",
  check: (val) => val instanceof Temporal.PlainDate,
  restore: (str) => Temporal.PlainDate.from(str),
  sanitize: (val) => val.toString(),
};

const plainTimeTypes: ICustomType<Temporal.PlainTime, string> = {
  name: "plainTime",
  check: (val) => val instanceof Temporal.PlainTime,
  restore: (str) => Temporal.PlainTime.from(str),
  sanitize: (val) => val.toString(),
};

const instantTypes: ICustomType<Temporal.Instant, string> = {
  name: "instant",
  check: (val) => val instanceof Temporal.Instant,
  restore: (str) => Temporal.Instant.from(str),
  sanitize: (val) => val.toString(),
};

export const ALL_TYPES = [
  ...defaultTypes,
  zonedDateTimeTypes,
  plainDateTypes,
  plainTimeTypes,
  instantTypes,
];

export const restore: typeof zenjsonRestore = createRestore(ALL_TYPES);

export const sanitize: typeof zenjsonSanitize = createSanitize(ALL_TYPES);
