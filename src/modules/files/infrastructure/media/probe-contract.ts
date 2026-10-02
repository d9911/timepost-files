// Форма ответа ffprobe; значения дополнительно проверяются адаптером во время работы.
export interface VideoProbe {
  format?: { duration?: string; format_name?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
  }[];
}
