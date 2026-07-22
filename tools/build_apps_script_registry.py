#!/usr/bin/env python3
"""Convert config/sources.json into an Apps Script source registry."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

FUNCTIONS = r"""

function ensureSourceRegistry_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG_REGISTRY_SHEET);
  if (!sh) sh = ss.insertSheet(CFG_REGISTRY_SHEET);

  var headers = [
    'Включен', 'Контур', 'Платформа', 'Название', 'URL',
    'Задача', 'Ответственные', 'Статус', 'Заметка', 'ID'
  ];
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  var existing = {};
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 5, sh.getLastRow() - 1, 1).getValues().forEach(function(r) {
      var url = String(r[0] || '').trim();
      if (url) existing[urlKey_(url)] = true;
    });
  }

  var rows = [];
  SOURCE_REGISTRY.forEach(function(s) {
    var key = urlKey_(s.url);
    if (!key || existing[key]) return;
    rows.push([
      s.enabled !== false,
      s.scope,
      s.platform,
      s.name,
      s.url,
      s.workflow,
      (s.owners || []).join(', '),
      s.enabled === false ? 'проверить адрес' : 'активен',
      s.notes || '',
      s.id
    ]);
    existing[key] = true;
  });

  if (rows.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, headers.length).setValues(rows);
    sh.getRange(start, 1, rows.length, 1).insertCheckboxes();
  }
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#37474F').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 80);
  sh.setColumnWidth(2, 120);
  sh.setColumnWidth(3, 110);
  sh.setColumnWidth(4, 210);
  sh.setColumnWidth(5, 360);
  sh.setColumnWidth(6, 150);
  sh.setColumnWidth(7, 140);
  sh.setColumnWidth(8, 130);
  sh.setColumnWidth(9, 260);
  return rows.length;
}

function syncSourceRegistry() {
  var added = ensureSourceRegistry_();
  SpreadsheetApp.getUi().alert(
    'Реестр источников обновлён.\n\n' +
    'Добавлено новых адресов: ' + added + '.\n' +
    'Ваши собственные строки и изменения сохранены.'
  );
}

function loadRegistrySources_(filters) {
  var sh = SpreadsheetApp.getActive().getSheetByName(CFG_REGISTRY_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues()
    .map(function(r) {
      return {
        enabled: r[0] === true || String(r[0]).toLowerCase() === 'true',
        scope: String(r[1] || '').trim(),
        platform: String(r[2] || '').trim(),
        name: String(r[3] || '').trim(),
        url: String(r[4] || '').trim(),
        workflow: String(r[5] || '').trim(),
        owners: String(r[6] || '').trim(),
        status: String(r[7] || '').trim(),
        notes: String(r[8] || '').trim(),
        id: String(r[9] || '').trim()
      };
    })
    .filter(function(s) {
      if (!s.enabled || !/^https?:\/\//i.test(s.url)) return false;
      if (!filters) return true;
      if (filters.scope && s.scope !== filters.scope) return false;
      if (filters.platform && s.platform !== filters.platform) return false;
      if (filters.workflow && s.workflow !== filters.workflow) return false;
      return true;
    });
}
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("registry", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads(args.registry.read_text(encoding="utf-8"))
    payload = json.dumps(data["sources"], ensure_ascii=False, indent=2)
    text = (
        "// Generated from config/sources.json. Edit sources in the Google Sheet.\n"
        "var SOURCE_REGISTRY = " + payload + ";\n" + FUNCTIONS.lstrip()
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text, encoding="utf-8")
    print(f"Wrote {len(data['sources'])} sources to {args.output}")


if __name__ == "__main__":
    main()
