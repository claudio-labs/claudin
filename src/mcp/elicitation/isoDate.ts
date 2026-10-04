const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ZONED_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/
/** What the model may answer: a date, or a date-time whose seconds and zone are optional. */
const LOOSE_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
const ZONE_OFFSET = /^[+-](\d{2}):(\d{2})$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** `YYYY-MM-DD` naming a day that exists. */
export function isCalendarDate(text: string): boolean {
  const parts = CALENDAR_DATE.exec(text)
  if (!parts) return false
  const [year, month, day] = parts.slice(1).map(Number) as [number, number, number]
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function isClockTime(hours: string, minutes: string, seconds = '00'): boolean {
  return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59
}

function isZone(zone: string | undefined): boolean {
  if (zone === undefined || zone === 'Z') return true
  const parts = ZONE_OFFSET.exec(zone)
  return parts !== null && Number(parts[1]) <= 23 && Number(parts[2]) <= 59
}

function matchesDateTime(pattern: RegExp, text: string): boolean {
  const parts = pattern.exec(text)
  if (!parts) return false
  const [, date, hours, minutes, seconds, zone] = parts as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
    string | undefined,
  ]
  return isCalendarDate(date) && isClockTime(hours, minutes, seconds) && isZone(zone)
}

/** `YYYY-MM-DDTHH:MM:SS[.fff]` followed by `Z` or `±HH:MM`, every part in range. */
export function isZonedDateTime(text: string): boolean {
  return matchesDateTime(ZONED_DATE_TIME, text)
}

/** Any ISO 8601 date or date-time naming a real moment. */
export function isIsoDateOrDateTime(text: string): boolean {
  return isCalendarDate(text) || matchesDateTime(LOOSE_DATE_TIME, text)
}
