/**
 * What the UI shows about a ServiceNow record mirrored by `livemap sn`: which record a mirror path holds, its scope,
 * update set and last update. Read from the scope manifests (`<scope>.manifest.json` at the mirror root) and each
 * record's own metadata: a folder's `meta.json`, a script's `// @livemap-sn {...}` header line, or a JSON record's
 * fields. Only the fields below are read out, so no other value of a record (a property's value, a script body)
 * ever reaches the UI.
 */
export interface SnRecordInfo {
  /** Mirror path of the record: its folder for a folder record (portal, page, widget, flow), else its file. */
  path: string;
  /** True when `path` is a folder: every file under it belongs to the record. */
  dir: boolean;
  sysId: string;
  /** The record's table (`sys_class_name`), such as `sp_widget` or `sys_script`. */
  table: string;
  name: string;
  scope: string;
  /** The update set's sys_id, when the record names one. */
  updateSet?: string;
  updateSetName?: string;
  updatedBy?: string;
  /** `sys_updated_on` as the instance gives it (`YYYY-MM-DD HH:mm:ss`, UTC). */
  updatedOn?: string;
}

export interface SnIndex {
  /** The instance the records were pulled from (as given to `--instance`, or the manifest's). */
  instance: string;
  scopes: { scope: string; name?: string; sysId?: string }[];
  records: SnRecordInfo[];
}
