//! The designer's stand-in for the game's `DrawContext`: a display list of
//! `draw2d_*` calls (what yog-ui's renderer — or a mod's own render code —
//! issues) rasterized the way the Yog hosts draw them in game: coordinates
//! truncated to whole GUI pixels (`NativeDraw` casts with `(int)`), alpha
//! blending, Minecraft's font (see [`font`](super::font)) and textures.
//! Output is RGBA at `scale` physical pixels per GUI pixel, for the canvas
//! to show with nearest-neighbour scaling.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::assets::{Image, Resources};
use super::font::{Font, Glyph, styled};

/// One `draw2d_*` call (GUI pixels, colors `0xAARRGGBB`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum DrawOp {
    Rect {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: u32,
    },
    Gradient {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        top: u32,
        bottom: u32,
    },
    Text {
        text: String,
        font: String,
        x: f32,
        y: f32,
        color: u32,
        shadow: bool,
    },
    Item {
        id: String,
        x: f32,
        y: f32,
        size: f32,
    },
    /// `draw2d_image`: a Yog image source into `x, y, w, h`; `region` `u v w h` (see [`images`](super::images)).
    Image {
        source: String,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        region: [f32; 4],
        tint: u32,
    },
    Scissor {
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    },
    ClearScissor,
}

/// An RGBA canvas `w × h` physical pixels.
pub struct Canvas<'r> {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
    scale: f32,
    clip: Option<(i32, i32, i32, i32)>,
    res: &'r Resources,
    fonts: HashMap<String, Arc<Font>>,
}

/// Straight-alpha "over".
fn blend(dst: &mut [u8], src: [f32; 4]) {
    let sa = src[3];
    if sa <= 0.0 {
        return;
    }
    let da = dst[3] as f32 / 255.0;
    let oa = sa + da * (1.0 - sa);
    for i in 0..3 {
        let d = dst[i] as f32 / 255.0;
        let o = (src[i] * sa + d * da * (1.0 - sa)) / oa;
        dst[i] = (o * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    dst[3] = (oa * 255.0).round().clamp(0.0, 255.0) as u8;
}

fn argb(c: u32) -> [f32; 4] {
    [
        ((c >> 16) & 0xFF) as f32 / 255.0,
        ((c >> 8) & 0xFF) as f32 / 255.0,
        (c & 0xFF) as f32 / 255.0,
        (c >> 24) as f32 / 255.0,
    ]
}

/// The game draws text whose alpha is (almost) 0 fully opaque (`Font.adjustColor`).
fn text_color(c: u32) -> u32 {
    if c & 0xFC00_0000 == 0 {
        c | 0xFF00_0000
    } else {
        c
    }
}

impl<'r> Canvas<'r> {
    pub fn new(gui_w: u32, gui_h: u32, scale: u32, res: &'r Resources) -> Self {
        let (w, h) = (gui_w * scale, gui_h * scale);
        Canvas {
            w,
            h,
            rgba: vec![0; w as usize * h as usize * 4],
            scale: scale as f32,
            clip: None,
            res,
            fonts: HashMap::new(),
        }
    }

    pub fn font(&mut self, id: &str) -> Arc<Font> {
        let res = self.res;
        self.fonts
            .entry(id.to_string())
            .or_insert_with(|| Font::load(res, id))
            .clone()
    }

    /// Physical pixel span of GUI `[a, b)`, inside the canvas (and the clip).
    fn span(&self, a: f32, b: f32, vertical: bool) -> (i32, i32) {
        let max = if vertical { self.h } else { self.w } as i32;
        let (mut lo, mut hi) = (
            (a * self.scale).floor() as i32,
            (b * self.scale).floor() as i32,
        );
        if let Some((cx, cy, cw, ch)) = self.clip {
            let (c0, c1) = if vertical {
                (cy, cy + ch)
            } else {
                (cx, cx + cw)
            };
            lo = lo.max((c0 as f32 * self.scale) as i32);
            hi = hi.min((c1 as f32 * self.scale) as i32);
        }
        (lo.max(0), hi.min(max))
    }

    fn px(&mut self, x: i32, y: i32) -> &mut [u8] {
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        &mut self.rgba[i..i + 4]
    }

    pub fn fill(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, top: u32, bottom: u32) {
        let (x1, x2) = (
            (x1 as i32).min(x2 as i32) as f32,
            (x1 as i32).max(x2 as i32) as f32,
        );
        let (y1, y2) = (
            (y1 as i32).min(y2 as i32) as f32,
            (y1 as i32).max(y2 as i32) as f32,
        );
        let (xa, xb) = self.span(x1, x2, false);
        let (ya, yb) = self.span(y1, y2, true);
        let (t, b) = (argb(top), argb(bottom));
        let height = ((y2 - y1) * self.scale).max(1.0);
        for py in ya..yb {
            let f = ((py as f32 + 0.5 - y1 * self.scale) / height).clamp(0.0, 1.0);
            let c = [0, 1, 2, 3].map(|i| t[i] + (b[i] - t[i]) * f);
            for px in xa..xb {
                blend(self.px(px, py), c);
            }
        }
    }

    /// Draws `img` texels `(u, v)`–`(u + w·tw/…)` into GUI box `x, y, w, h`
    /// — UVs normalized against the declared texture size `tw × th`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn blit(
        &mut self,
        img: &Image,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        uv: [f32; 4],
        tint: [f32; 4],
    ) {
        let (xa, xb) = self.span(x, x + w, false);
        let (ya, yb) = self.span(y, y + h, true);
        let [u0, v0, u1, v1] = uv;
        for py in ya..yb {
            let fy = ((py as f32 + 0.5) / self.scale - y) / h;
            let ty = ((v0 + (v1 - v0) * fy) * img.h as f32).floor() as i64;
            if ty < 0 || ty >= img.h as i64 {
                continue;
            }
            for px in xa..xb {
                let fx = ((px as f32 + 0.5) / self.scale - x) / w;
                let tx = ((u0 + (u1 - u0) * fx) * img.w as f32).floor() as i64;
                if tx < 0 || tx >= img.w as i64 {
                    continue;
                }
                let t = img.pixel(tx as u32, ty as u32);
                let c = [0, 1, 2, 3].map(|i| t[i] as f32 / 255.0 * tint[i]);
                blend(self.px(px, py), c);
            }
        }
    }

    fn glyph(&mut self, g: &Glyph, x: f32, y: f32, color: u32) {
        let Some(b) = &g.bitmap else { return };
        let img = Image {
            w: b.w,
            h: b.h,
            rgba: b.rgba.clone(),
        };
        self.blit(
            &img,
            x,
            y + b.top,
            b.w as f32 / b.oversample,
            b.h as f32 / b.oversample,
            [0.0, 0.0, 1.0, 1.0],
            argb(color),
        );
    }

    /// `Font.drawInBatch`: the shadow pass (offset, color / 4), then the text.
    pub fn text(&mut self, text: &str, font: &str, x: f32, y: f32, color: u32, shadow: bool) {
        let font = self.font(font);
        let (x, y) = ((x as i32) as f32, (y as i32) as f32);
        let chars = styled(text, text_color(color));
        let passes: &[bool] = if shadow { &[true, false] } else { &[false] };
        for &is_shadow in passes {
            let mut pen = x;
            for s in &chars {
                let g = font.glyph(s.ch);
                let c = if is_shadow {
                    (s.color & 0xFF00_0000) | ((s.color & 0x00FC_FCFC) >> 2)
                } else {
                    s.color
                };
                let off = if is_shadow { g.shadow_offset } else { 0.0 };
                self.glyph(&g, pen + off, y + off, c);
                let mut adv = g.advance;
                if s.bold {
                    self.glyph(&g, pen + off + g.bold_offset, y + off, c);
                    adv += g.bold_offset;
                }
                if s.underline {
                    self.fill(
                        pen + off - 1.0,
                        y + off + 9.0,
                        pen + off + adv,
                        y + off + 8.0,
                        c,
                        c,
                    );
                }
                if s.strike {
                    self.fill(
                        pen + off - 1.0,
                        y + off + 4.5,
                        pen + off + adv,
                        y + off + 3.5,
                        c,
                        c,
                    );
                }
                pen += adv;
            }
        }
    }

    pub fn draw(&mut self, op: &DrawOp) {
        match op {
            DrawOp::Rect {
                x1,
                y1,
                x2,
                y2,
                color,
            } => self.fill(*x1, *y1, *x2, *y2, *color, *color),
            DrawOp::Gradient {
                x1,
                y1,
                x2,
                y2,
                top,
                bottom,
            } => self.fill(*x1, *y1, *x2, *y2, *top, *bottom),
            DrawOp::Text {
                text,
                font,
                x,
                y,
                color,
                shadow,
            } => self.text(text, font, *x, *y, *color, *shadow),
            DrawOp::Item { id, x, y, size } => {
                // The 3D item renderer isn't reproduced: the item's flat texture (block items: the block's).
                let (ns, name) = super::assets::split_id(id);
                let img = self
                    .res
                    .texture(&format!("{ns}:textures/item/{name}.png"))
                    .or_else(|| self.res.texture(&format!("{ns}:textures/block/{name}.png")))
                    .unwrap_or_else(|| Arc::new(Image::missing()));
                let frame = img.w.min(img.h) as f32;
                let v1 = frame / img.h as f32;
                self.blit(&img, *x, *y, *size, *size, [0.0, 0.0, 1.0, v1], [1.0; 4]);
            }
            DrawOp::Image {
                source,
                x,
                y,
                w,
                h,
                region,
                tint,
            } => super::images::draw(self, source, [*x, *y, *w, *h], *region, *tint),
            DrawOp::Scissor { x, y, w, h } => self.clip = Some((*x, *y, *w, *h)),
            DrawOp::ClearScissor => self.clip = None,
        }
    }

    pub fn png(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, self.w, self.h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&self.rgba)
            .map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        Ok(out)
    }
}

/// The most physical pixels a canvas gets (256 MiB of RGBA).
const MAX_PIXELS: u64 = 1 << 26;

/// `scale` clamped to 1..=8, lowered until a `gui_w`×`gui_h` canvas fits [`MAX_PIXELS`].
pub fn fit_scale(gui_w: u32, gui_h: u32, scale: u32) -> u32 {
    let gui = u64::from(gui_w) * u64::from(gui_h);
    let mut scale = scale.clamp(1, 8);
    while scale > 1 && gui.saturating_mul(u64::from(scale * scale)) > MAX_PIXELS {
        scale -= 1;
    }
    scale
}

/// Rasterizes a display list.
pub fn rasterize<'r>(
    ops: &[DrawOp],
    gui_w: u32,
    gui_h: u32,
    scale: u32,
    res: &'r Resources,
) -> Canvas<'r> {
    let mut canvas = Canvas::new(gui_w, gui_h, fit_scale(gui_w, gui_h, scale), res);
    for op in ops {
        canvas.draw(op);
    }
    canvas
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res() -> Resources {
        Resources {
            mod_root: None,
            vanilla: None,
        }
    }

    #[test]
    fn huge_canvases_lower_their_scale() {
        assert_eq!(fit_scale(400, 300, 3), 3);
        assert_eq!(fit_scale(400, 300, 0), 1);
        assert_eq!(fit_scale(4096, 4096, 8), 2);
        assert_eq!(fit_scale(u32::MAX, u32::MAX, 8), 1);
    }

    #[test]
    fn rects_truncate_to_gui_pixels_and_blend() {
        let r = res();
        let c = rasterize(
            &[DrawOp::Rect {
                x1: 1.7,
                y1: 0.0,
                x2: 3.2,
                y2: 1.0,
                color: 0xFF_FF0000,
            }],
            4,
            1,
            2,
            &r,
        );
        // x 1..3 → physical 2..6
        let px = |x: usize| &c.rgba[x * 4..x * 4 + 4];
        assert_eq!(px(1), &[0, 0, 0, 0]);
        assert_eq!(px(2), &[255, 0, 0, 255]);
        assert_eq!(px(5), &[255, 0, 0, 255]);
        assert_eq!(px(6), &[0, 0, 0, 0]);
    }

    #[test]
    fn scissor_clips() {
        let r = res();
        let ops = [
            DrawOp::Scissor {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            DrawOp::Rect {
                x1: 0.0,
                y1: 0.0,
                x2: 2.0,
                y2: 1.0,
                color: 0xFF_FFFFFF,
            },
        ];
        let c = rasterize(&ops, 2, 1, 1, &r);
        assert_eq!(c.rgba[3], 255);
        assert_eq!(c.rgba[7], 0);
    }

    #[test]
    fn missing_font_draws_boxes_with_the_shadow_first() {
        let r = res();
        let mut c = Canvas::new(16, 10, 1, &r);
        c.text("A", "", 0.0, 0.0, 0xFF_FFFFFF, true);
        // Missing glyph box: top-left texel white, shadow at (1,1) under the text's own (1,1)? (1,1) is the box's inside → shadow shows.
        assert_eq!(&c.rgba[0..4], &[255, 255, 255, 255]);
        let i = (16 + 1) * 4;
        assert_eq!(&c.rgba[i..i + 4], &[63, 63, 63, 255]);
    }
}
