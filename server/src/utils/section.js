/**
 * How a cohort is named in prose.
 *
 * A section with no name is not an error — it is an undivided semester, where
 * every student sits the same timetable and there is nothing to distinguish.
 * "All students" is what an administrator should read in that case, never
 * "Section " with a blank after it.
 *
 * Lives here rather than on the model because it is arithmetic on a name, not
 * a database concern, and the model file it came from is on its way out.
 */
export const sectionLabel = (section) =>
  section?.name ? `Section ${section.name}` : 'All students';
