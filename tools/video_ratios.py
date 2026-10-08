"""Aspect ratios offered by the Doubao and Dola video composers."""

VIDEO_FIXED_RATIOS = ('9:16', '16:9', '1:1', '3:4', '4:3', '21:9')
VIDEO_RATIOS = (*VIDEO_FIXED_RATIOS, 'auto')


def validate_source_dimensions(width, height):
    # Match the tracker's memory budget while allowing platform resolutions to vary.
    if (not isinstance(width, int) or not isinstance(height, int)
            or not 64 <= width <= 4096 or not 64 <= height <= 4096
            or width * height > 8_500_000):
        raise RuntimeError('WATERMARK_REPAIR_UNSUPPORTED_LAYOUT')


def delivery_dimensions(ratio, source_width, source_height):
    if ratio not in VIDEO_RATIOS:
        raise RuntimeError('INVALID_ASPECT_RATIO')
    validate_source_dimensions(source_width, source_height)
    if ratio == 'auto':
        # Retain the source frame; yuv420p needs even dimensions, so pad at most one pixel.
        return source_width + source_width % 2, source_height + source_height % 2
    if ratio == '1:1':
        return 960, 960
    width, height = map(int, ratio.split(':'))
    factor = 2 * max(1, 1280 // (2 * max(width, height)))
    return width * factor, height * factor
