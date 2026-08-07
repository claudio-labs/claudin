/**
 * Jupyter notebook (`.ipynb`) shapes.
 *
 * The original module was not carried into this fork, so these types are
 * reconstructed from their use sites rather than from the nbformat spec:
 * `src/utils/notebook.ts` (read + tool-result mapping),
 * `src/tools/NotebookEditTool/NotebookEditTool.ts` (cell insert/replace/delete)
 * and `src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx`
 * (diff preview). Only the fields that code actually touches are modelled —
 * a parsed notebook carries plenty more, it just never reaches these types.
 */

/**
 * Cell kinds the tooling handles. `NotebookEditTool`'s schema accepts exactly
 * these two, and nothing downstream branches on any other value.
 */
export type NotebookCellType = 'code' | 'markdown'

/** Discriminant shared by a raw output and its processed counterpart. */
type NotebookOutputType = 'stream' | 'execute_result' | 'display_data' | 'error'

/**
 * MIME bundle of an `execute_result` / `display_data` output. Values are
 * narrowed to what the readers expect: `text/plain` is fed to the output
 * formatter, and `image/png` / `image/jpeg` are read as base64 strings.
 */
type NotebookMimeBundle = {
  [mimeType: string]: string | string[] | undefined
}

/** An output exactly as it appears in the `.ipynb` JSON. */
export type NotebookCellOutput =
  | {
      output_type: 'stream'
      text?: string | string[]
    }
  | {
      output_type: 'execute_result' | 'display_data'
      data?: NotebookMimeBundle
    }
  | {
      output_type: 'error'
      ename: string
      evalue: string
      traceback: string[]
    }

/** A cell exactly as it appears in the `.ipynb` JSON. */
export type NotebookCell = {
  cell_type: NotebookCellType
  /** nbformat 4.5+; older notebooks omit it and readers fall back to the index. */
  id?: string
  /** Split across lines by most writers, but a single string is valid too. */
  source: string | string[]
  metadata: Record<string, unknown>
  /** Code cells only. `null` means "not executed since the last edit". */
  execution_count?: number | null
  /** Code cells only. */
  outputs?: NotebookCellOutput[]
}

/** A parsed notebook file. */
export type NotebookContent = {
  cells: NotebookCell[]
  metadata: {
    language_info?: {
      name?: string
    }
  }
}

/** Base64 image lifted out of an output's MIME bundle. */
export type NotebookOutputImage = {
  image_data: string
  media_type: 'image/png' | 'image/jpeg'
}

/** An output after `readNotebook` has flattened and truncated it. */
export type NotebookCellSourceOutput = {
  output_type: NotebookOutputType
  text?: string
  image?: NotebookOutputImage
}

/** A cell after `readNotebook` has flattened it for the model. */
export type NotebookCellSource = {
  cellType: NotebookCellType
  source: string
  cell_id: string
  execution_count?: number
  /** Set for code cells only, so markdown is not labelled with the kernel language. */
  language?: string
  outputs?: NotebookCellSourceOutput[]
}
