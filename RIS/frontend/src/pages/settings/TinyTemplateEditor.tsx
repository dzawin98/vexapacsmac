import { useEffect, useRef } from "react";
import { Editor } from "@tinymce/tinymce-react";
import type { Editor as TinyMCEEditor } from "tinymce";
import "tinymce/tinymce";
import "tinymce/icons/default";
import "tinymce/themes/silver";
import "tinymce/models/dom";
import "tinymce/plugins/table";
import "tinymce/plugins/lists";
import "tinymce/plugins/link";
import "tinymce/plugins/code";
import "tinymce/plugins/visualblocks";
import "tinymce/plugins/searchreplace";
import "tinymce/plugins/charmap";
import "tinymce/skins/ui/oxide/skin.min.css";
import {
  DEFAULT_EXPERTISE_TEMPLATE,
  LETTERHEAD_PAGE_MARGIN_MM,
  LETTERHEAD_PRINT_HEIGHT_MM,
} from "@/lib/dicomService";

type TinyTemplateEditorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

const placeholders = [
  "{{header_html}}",
  "{{patient_name}}",
  "{{patient_id}}",
  "{{gender}}",
  "{{birth_date}}",
  "{{age}}",
  "{{birth_date_age}}",
  "{{study_description}}",
  "{{study_date}}",
  "{{study_time}}",
  "{{study_datetime}}",
  "{{report_date}}",
  "{{referring_physician}}",
  "{{radiologist_name}}",
  "{{clinical_info}}",
  "{{findings}}",
  "{{conclusion}}",
  "{{report_content}}",
  "{{qr_html}}",
  "{{qr_image_html}}",
  "{{qr_label}}",
  "{{qr_expiry}}",
  "{{qr_block_html}}",
  "{{signature_html}}",
  "{{signature_name}}",
];

const TinyTemplateEditor = ({ value, onChange, disabled }: TinyTemplateEditorProps) => {
  const editorRef = useRef<TinyMCEEditor | null>(null);

  useEffect(() => {
    editorRef.current?.mode.set(disabled ? "readonly" : "design");
  }, [disabled]);

  const insertPlaceholder = (placeholder: string) => {
    if (!disabled) editorRef.current?.insertContent(placeholder);
  };

  const insertHtmlBlock = (htmlBlock: string) => {
    if (!disabled) editorRef.current?.insertContent(htmlBlock);
  };

  return (
    <div className="min-w-0 max-w-full space-y-3 overflow-hidden">
      <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-muted/30 p-4">
        <div className="mx-auto min-w-0 w-full max-w-[840px] overflow-hidden rounded-lg border border-border bg-background shadow-sm">
          <Editor
            licenseKey="gpl"
            onInit={(_event, editor) => {
              editorRef.current = editor;
              editor.mode.set(disabled ? "readonly" : "design");
            }}
            value={value?.trim() ? value : DEFAULT_EXPERTISE_TEMPLATE}
            onEditorChange={onChange}
            disabled={disabled}
            init={{
              height: 700,
              width: "100%",
              resize: false,
              branding: false,
              promotion: false,
              menubar: "file edit view insert format table tools",
              plugins: "table lists link code visualblocks searchreplace charmap",
              toolbar:
                "undo redo | blocks | bold italic underline | alignleft aligncenter alignright | bullist numlist | table | qrtable placeholder | code",
              content_style:
                `body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12px; } .letterhead-frame { width: calc(100% + ${LETTERHEAD_PAGE_MARGIN_MM * 2}mm); height: ${LETTERHEAD_PRINT_HEIGHT_MM}mm; margin: 0 -${LETTERHEAD_PAGE_MARGIN_MM}mm 12px; overflow: hidden; text-align: center; page-break-inside: avoid; } .header-image { display: block; width: 100%; height: 100%; max-width: 100%; max-height: ${LETTERHEAD_PRINT_HEIGHT_MM}mm; object-fit: fill; object-position: center center; border: 0; } .print-border, .print-border td, .print-border th { border: 1px dashed #bbb; } .qr-block { width: 160px; text-align: center; } .signature-title { font-size: 12px; margin-bottom: 6px; } .signature-role { font-size: 12px; margin-bottom: 10px; } .signature-name { font-size: 12px; font-weight: 600; }`,
              setup: editor => {
                editor.ui.registry.addButton("qrtable", {
                  text: "QR+Signature",
                  onAction: () => {
                    editor.insertContent(
                      `<table class="print-border" style="width:100%;border-collapse:collapse;border:1px dashed #bbb;margin-top:16px;"><tr><td class="print-border" style="width:50%;border:1px dashed #bbb;vertical-align:top;padding:10px;text-align:center;"><div style="font-size:10px;color:#666;margin-bottom:6px;">QR Area</div><div class="qr-block">{{qr_image_html}}<div class="qr-label">{{qr_label}}</div><div class="qr-exp">{{qr_expiry}}</div></div></td><td class="print-border" style="width:50%;border:1px dashed #bbb;vertical-align:top;padding:10px;text-align:center;"><div style="font-size:10px;color:#666;margin-bottom:6px;">Signature Area</div><div class="signature-title">Created By:</div><div class="signature-role">Radiology Specialist</div>{{signature_html}}<div class="signature-name">{{signature_name}}</div></td></tr></table>`
                    );
                  },
                });
                editor.ui.registry.addMenuButton("placeholder", {
                  text: "Placeholder",
                  fetch: callback => {
                    callback(
                      placeholders.map(item => ({
                        type: "menuitem",
                        text: item,
                        onAction: () => editor.insertContent(item),
                      }))
                    );
                  },
                });
              },
            }}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
        {placeholders.map(item => (
          <button
            key={item}
            type="button"
            className="rounded-lg border border-border bg-muted/30 px-2 py-1 font-mono text-left hover:bg-muted"
            onClick={() => insertPlaceholder(item)}
            disabled={disabled}
          >
            {item}
          </button>
        ))}
        <button
          type="button"
          className="rounded-lg border border-border bg-muted/30 px-2 py-1 font-mono text-left hover:bg-muted"
          onClick={() =>
            insertHtmlBlock(
              `<div class="footer-slot qr-slot"><div class="slot-label">QR Area</div><div class="qr-block">{{qr_image_html}}<div class="qr-label">{{qr_label}}</div><div class="qr-exp">{{qr_expiry}}</div><div class="qr-placeholder">QR here</div></div></div>`
            )
          }
          disabled={disabled}
        >
          QR Block
        </button>
      </div>
    </div>
  );
};

export default TinyTemplateEditor;
