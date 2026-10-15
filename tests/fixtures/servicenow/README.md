# ServiceNow fixtures

`bharatbank.json.gz` is a sanitised, read-only recording of the BharatBank POC scope (`x_snc_cc_offering`, "Credit Card Offering") on the `inmorphisdemo3` instance, taken on 15 Oct 2026 through SkyForge's nexus MCP. It is the fixture for the ServiceNow source (#60), its mock nexus server, and the attribution tests (#62).

Load it with:

```ts
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const fx = JSON.parse(gunzipSync(readFileSync('tests/fixtures/servicenow/bharatbank.json.gz')).toString('utf8'));
```

## Shape

| Key | Contents |
| --- | --- |
| `instance` | `{instance_name, release, patch}` |
| `scope` | `{sys_id, scope, name, version}` (the scope's `sys_id` is remapped like every other id) |
| `groundTruth.records` | 1683, the number of `sys_metadata` rows in the scope |
| `groundTruth.byClass` | count per `sys_class_name` for all 1,683 records; the authority for backfill tests |
| `groundTruth.mirrored` | count of full records included per table under `tables` |
| `tables.sys_metadata` | the full inventory, column-packed: `{columns:[sys_id, sys_class_name, sys_name, sys_created_on, sys_updated_on, sys_updated_by], rows:[[...], ...]}` |
| `tables.<table>` | full current records (array of field objects, as `sn_query_table` returns them) for: `sp_portal`, `sp_page`, `sp_container`, `sp_row`, `sp_column`, `sp_instance`, `sp_widget`, `sys_db_object`, `sys_dictionary`, `sys_script`, `sys_script_include`, `sys_ui_action`, `sys_security_acl`, `sys_security_acl_role`, `sys_hub_flow`, `sys_ux_app_route`, `sys_ux_screen` |
| `sys_update_xml` | 183 rows in `sys_updated_on` order: every row for widgets, business rules, script includes, pages, tables, UI actions, portal, flows and workspace routes, the first 25 dictionary rows, and 15 DELETE rows. Repeat versions of the same record are included, so they double as version history. Each `payload` is a valid `<record_update table=...><table action=...>fields</table></record_update>` built from the sanitised fields |
| `mcpLogExcerpt.lines` | 400 lines from `~/.skyforge/skyforge-mcp.log` (29 May to 22 Sep 2026) touching these classes. Format: `[ts] [INFO] [Tool] <tool> \| k=v, ...` and `[ts] [INFO] [Tool] <tool> ✅ <ms>`. Ids here use a separate remap (prefix `6e`), so match on table, action and time, not id |

## Sanitisation

- Every 32-hex `sys_id` (and reference) is remapped consistently to `5f` + a zero-padded counter, so references between records still resolve.
- User names other than `admin`, `system`, `guest`, `maint` are remapped to `dev.userN`.
- Scripts, templates, CSS and link functions are replaced with synthetic code that keeps the cross-references the analyzer needs: `new X()`, `new GlideRecord('t')`, `gs.include('X')`, `new GlideAjax('X')`, `$sp.getWidget('id')`, embedded `<sp-widget widget="...">` tags, and script include method names. Business logic is not present.
- Free-text fields (descriptions, messages, agent instructions) are dropped; only the fields listed in the design doc's mirror layout are kept. `widget_parameters` keep their keys with synthetic values. Long conditions are replaced with `active=true`.
- Record names, labels, table and field names are kept: they are app metadata from a demo POC, and the tests need them.

To use it as a mock nexus: serve `sn_query_table` by filtering `tables[table]` (or the column-packed inventory for `sys_metadata`) with a minimal encoded-query matcher (`field=value`, `^` AND, `sys_updated_on>value`), honour `limit`/`offset`, and return `{success:true, data:{records, count, total, has_more}}`. Serve `sys_update_version` from the `sys_update_xml` rows when a test needs version history.
