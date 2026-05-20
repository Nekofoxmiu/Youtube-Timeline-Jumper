const FALLBACK_MESSAGES = Object.freeze({
  ytj_import_playlist: 'Import Playlist',
  ytj_edit_playlist: 'Edit Playlist',
  ytj_export_playlist: 'Export Playlist',
  ytj_single_playback: 'Single Playback',
  ytj_import: 'Import',
  ytj_save: 'Save',
  ytj_cancel: 'Cancel',
  ytj_copy: 'Copy',
  ytj_close: 'Close',
  ytj_simple_editor: 'Simple editor',
  ytj_text_mode: 'Text mode',
  ytj_default_duration: 'Default duration',
  ytj_delimiter: 'Delimiter',
  ytj_time_delimiter: 'Time delimiter',
  ytj_title_delimiter: 'Title delimiter',
  ytj_custom: 'Custom',
  ytj_custom_delimiter: 'Custom delimiter',
  ytj_numbering: 'Numbering',
  ytj_numbering_padding: 'Number padding',
  ytj_padding_none: 'None',
  ytj_padding_zero: 'Zero',
  ytj_padding_space: 'Space',
  ytj_padding_width: 'Width',
  ytj_round_export_seconds: 'Round to whole seconds',
  ytj_auto_detect: 'Auto detect',
  ytj_delimiter_space: 'Space',
  ytj_numbering_none: 'None',
  ytj_delete: 'Delete',
  ytj_add_row: 'Add row',
  ytj_drag: 'Drag',
  ytj_drag_playlist_item: 'Drag playlist item',
  ytj_drag_to_reorder: 'Drag to reorder',
  ytj_currently_playing: 'Currently playing',
  ytj_play_from_here: 'Play from here',
  ytj_set_start_time: 'Set start time',
  ytj_set_end_time: 'Set end time',
  ytj_title_placeholder: 'Title',
  ytj_import_placeholder: 'Paste lines like: 1. 00:01:23 - 00:02:34 - Song title',
  ytj_import_flexible_hint: 'Parsing is intentionally flexible. You can paste most common timestamp formats and try importing directly.',
  ytj_duration_placeholder: 'e.g., 30',
  ytj_time_placeholder: '00:00:00',
  ytj_auto_song: 'Auto Song',
  ytj_auto_song_provisional: 'Auto Song (Provisional)',
});

export function t(key, substitutions) {
  try {
    const message = globalThis.chrome?.i18n?.getMessage?.(key, substitutions);
    if (message) return message;
  } catch (error) {
    // chrome.i18n is unavailable in plain Node checks.
  }
  return FALLBACK_MESSAGES[key] || key;
}
