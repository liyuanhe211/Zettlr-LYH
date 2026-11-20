/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tab label disambiguation
 * CVM-Role:        Utility functions
 * License:         GNU GPL v3
 *
 * Description:     Decides which directory name the tab bar (DocumentTabs.vue)
 *                  shows behind the file name of a tab, if several tabs of one
 *                  tab bar share the same display name (R89). For every file
 *                  of such a group, the directory name is taken from the first
 *                  level, counted from the direct parent directory upwards,
 *                  on which the file differs from every other file of the
 *                  group. The module depends neither on Vue nor on the stores,
 *                  and it accepts Windows paths (with backslashes) as well as
 *                  paths with forward slashes.
 *
 * END HEADER
 */

/** Longer directory names (counted in Unicode code points) are shortened */
const MAXIMUM_DIRECTORY_NAME_LENGTH = 18
/** Code points kept at the beginning of a shortened directory name */
const KEPT_PREFIX_LENGTH = 8
/** Code points kept at the end of a shortened directory name */
const KEPT_SUFFIX_LENGTH = 7
/** Replaces the removed middle part of a shortened directory name */
const ELLIPSIS = '...'
/** Joins several directory names within one label */
const LABEL_SEPARATOR = '\\'

/**
 * How far a label of a file is spelled out. Stage 0 is the directory name on
 * the distinguishing level only, stage 1 all directory names from that level
 * down to the direct parent directory, stage 2 the complete parent path.
 */
type LabelStage = 0|1|2

/**
 * Shortens a directory name for display: names of more than 18 code points keep
 * their first 8 and their last 7 code points, joined by three periods; names of
 * 18 code points or fewer stay as they are. The name is cut between code
 * points, never inside a surrogate pair.
 *
 * @param   {string}  name  The complete directory name
 *
 * @return  {string}        The name as displayed in a tab
 */
export function abbreviateDirectoryName (name: string): string {
  const codePoints = Array.from(name)
  if (codePoints.length <= MAXIMUM_DIRECTORY_NAME_LENGTH) {
    return name
  }

  const prefix = codePoints.slice(0, KEPT_PREFIX_LENGTH).join('')
  const suffix = codePoints.slice(codePoints.length - KEPT_SUFFIX_LENGTH).join('')
  return prefix + ELLIPSIS + suffix
}

/**
 * Splits the parent directories of a file into their names, ordered from the
 * direct parent directory (level 1, the first entry) upwards. The topmost entry
 * is the drive letter (such as "E:") or the server name of a UNC path.
 *
 * @param   {string}    filePath  The absolute path of the file
 *
 * @return  {string[]}            The directory names, direct parent first
 */
function listDirectoryLevels (filePath: string): string[] {
  const segments = filePath.split(/[\\/]+/).filter(segment => segment !== '')
  // The last segment is the name of the file itself
  return segments.slice(0, -1).reverse()
}

/**
 * Returns the first level on which two files differ: the smallest level for
 * which the two directory names are different, ignoring upper and lower case.
 * A level that exists for one file only counts as different, too.
 *
 * @param   {string[]}  first   The directory levels of one file
 * @param   {string[]}  second  The directory levels of the other file
 *
 * @return  {number}            The first differing level, counted from 1
 */
function findFirstDifferingLevel (first: string[], second: string[]): number {
  const deepest = Math.max(first.length, second.length)
  for (let index = 0; index < deepest; index++) {
    if (
      index >= first.length ||
      index >= second.length ||
      first[index].toLowerCase() !== second[index].toLowerCase()
    ) {
      return index + 1
    }
  }

  // The same directory (apart from upper and lower case). Such files cannot be
  // told apart by their directory; the direct parent is the natural choice.
  return 1
}

/**
 * Lists the complete (not yet shortened) directory names a label consists of,
 * from the topmost one to the lowest one.
 *
 * @param   {string[]}    levels              The directory levels of the file
 * @param   {number}      distinguishingLevel The level that tells the file apart
 * @param   {LabelStage}  stage               How far the label is spelled out
 *
 * @return  {string[]}                        The directory names of the label
 */
function listLabelNames (levels: string[], distinguishingLevel: number, stage: LabelStage): string[] {
  if (stage === 0) {
    return levels.slice(distinguishingLevel - 1, distinguishingLevel)
  }

  const lastLevel = stage === 1 ? distinguishingLevel : levels.length
  return levels.slice(0, lastLevel).reverse()
}

/**
 * Computes, for a group of files that share the same display name, the
 * directory name that tells each of them apart from all the others.
 *
 * For each file, its parent directories are numbered from the direct parent
 * (level 1) upwards. The distinguishing level of a file is the largest of its
 * first differing levels (ignoring upper and lower case) to each of the other
 * files; the label is the directory name on that level. If several files
 * would get the same label, these files are shown with all directory names from
 * the distinguishing level down to level 1, joined by a backslash, and if
 * that is still not unique, with their complete parent path. Every single
 * directory name is shortened by abbreviateDirectoryName(), but the labels are
 * always compared by the complete names.
 *
 * @param   {string[]}              paths  The absolute paths of the files
 *
 * @return  {Map<string, string>}          For each path, its label
 */
export function computeDisambiguationLabels (paths: string[]): Map<string, string> {
  const uniquePaths = Array.from(new Set(paths))
  const allLevels = uniquePaths.map(listDirectoryLevels)

  const distinguishingLevels = allLevels.map((levels, index) => {
    let distinguishingLevel = 1
    for (let otherIndex = 0; otherIndex < allLevels.length; otherIndex++) {
      if (otherIndex !== index) {
        distinguishingLevel = Math.max(distinguishingLevel, findFirstDifferingLevel(levels, allLevels[otherIndex]))
      }
    }
    // A file with few parent directories cannot show a level it does not have
    return Math.min(distinguishingLevel, levels.length)
  })

  // Files that share a label are spelled out further, first to the lowest level,
  // then to the complete path. After that, only identical paths can be equal.
  const stages: LabelStage[] = uniquePaths.map(() => 0)
  for (let round = 0; round < 2; round++) {
    const keys = uniquePaths.map((_path, index) => {
      return listLabelNames(allLevels[index], distinguishingLevels[index], stages[index])
        .join(LABEL_SEPARATOR)
        .toLowerCase()
    })
    const occurrences = new Map<string, number>()
    for (const key of keys) {
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
    }

    for (let index = 0; index < uniquePaths.length; index++) {
      if ((occurrences.get(keys[index]) ?? 0) > 1 && stages[index] < 2) {
        stages[index] = (stages[index] + 1) as LabelStage
      }
    }
  }

  const labels = new Map<string, string>()
  for (let index = 0; index < uniquePaths.length; index++) {
    const names = listLabelNames(allLevels[index], distinguishingLevels[index], stages[index])
    labels.set(uniquePaths[index], names.map(abbreviateDirectoryName).join(LABEL_SEPARATOR))
  }
  return labels
}
