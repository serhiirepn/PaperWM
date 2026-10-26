import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Utils } from './imports.js';

/*
  Rounds window corners with a GLSL effect.

  The effect is attached to mutter's surface actor (the MetaSurface* child of
  the MetaWindowActor), not to the window actor itself: tiling clips window
  actors to their monitor (`actor.set_clip` in tiling.js), and an offscreen
  effect on a clipped actor gets the wrong paint bounds. Clones paint the
  source's children together with their effects, so tiling clones are rounded
  as well.

  Shader adapted from Rounded Window Corners Reborn (GPL-3.0),
  https://github.com/flexagoon/rounded-window-corners
 */

const EFFECT_NAME = 'paperwm-rounded-corners';
const ROUNDED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

let gsettings, signals, actorSignals, trackedActors;
let shader, uniforms;

const RoundedCornersEffect = GObject.registerClass(
    class RoundedCornersEffect extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
                shader.declarations, shader.code, false);
        }

        _init(metaWindow) {
            super._init();
            this.metaWindow = metaWindow;
            this.radius = 0;
            this.inset = 0;
            this._uniformValues = '';
        }

        /**
         * @param inset - pixels between the frame and the visible content,
         *   for clients that leave a transparent margin inside their frame
         */
        setShape(radius, inset) {
            this.radius = radius;
            this.inset = inset;
            this.queue_repaint();
        }

        /**
         * Bounds are computed on every paint: clients with client-side
         * shadows (eg. chromium) resize them on focus changes, and signals
         * about it can arrive a frame late.
         */
        vfunc_paint_target(node, paintContext) {
            this._syncUniforms();
            super.vfunc_paint_target(node, paintContext);
        }

        _syncUniforms() {
            // Use the buffer rect for the size: clients with subsurfaces
            // (eg. chromium, electron) get a MetaSurfaceContainerActorWayland
            // which reports a 0x0 size.
            const buffer = this.metaWindow.get_buffer_rect();
            if (buffer.width <= 0 || buffer.height <= 0)
                return;

            // round the frame, not the client-side shadows around it
            const frame = this.metaWindow.get_frame_rect();
            const x1 = frame.x - buffer.x + this.inset;
            const y1 = frame.y - buffer.y + this.inset;
            const x2 = frame.x - buffer.x + frame.width - this.inset;
            const y2 = frame.y - buffer.y + frame.height - this.inset;
            const radius = Math.max(0, Math.min(this.radius, (x2 - x1) / 2, (y2 - y1) / 2));
            const pixelStep = [1 / buffer.width, 1 / buffer.height];

            const values = `${x1},${y1},${x2},${y2},${radius},${buffer.width},${buffer.height}`;
            if (values === this._uniformValues)
                return;
            this._uniformValues = values;

            if (!uniforms) {
                uniforms = {
                    bounds: this.get_uniform_location('bounds'),
                    clipRadius: this.get_uniform_location('clipRadius'),
                    pixelStep: this.get_uniform_location('pixelStep'),
                };
            }
            this.set_uniform_float(uniforms.bounds, 4, [x1, y1, x2, y2]);
            this.set_uniform_float(uniforms.clipRadius, 1, [radius]);
            this.set_uniform_float(uniforms.pixelStep, 2, pixelStep);
        }
    });

export function enable(extension) {
    gsettings = extension.getSettings();
    shader ??= loadShader(extension.dir.get_child('resources/rounded_corners.frag').get_path());
    signals = new Utils.Signals();
    actorSignals = new Utils.Signals();
    trackedActors = new Set();

    signals.connect(global.window_manager, 'map', (_wm, actor) => track(actor));
    for (const key of ['enabled', 'radius', 'wm-classes', 'insets']) {
        signals.connect(gsettings, `changed::rounded-corners-${key}`, () => refreshAll());
    }

    global.get_window_actors().forEach(track);
}

export function disable() {
    signals.destroy();
    actorSignals.destroy();
    trackedActors.forEach(actor => removeEffect(actor));
    trackedActors.clear();
    signals = null;
    actorSignals = null;
    trackedActors = null;
    gsettings = null;
}

/**
 * Splits a fragment shader into declarations and the body of main(), as
 * expected by `add_glsl_snippet`.
 */
function loadShader(path) {
    const [, contents] = GLib.file_get_contents(path);
    const source = new TextDecoder().decode(contents);
    const [declarations, main] = source.split(/^void main\(\)\s*/m);
    return {
        declarations: declarations.trim(),
        code: main.trim().replace(/^\{|\}$/g, '').trim(),
    };
}

function track(actor) {
    if (trackedActors.has(actor))
        return;
    trackedActors.add(actor);

    const metaWindow = actor.meta_window;
    actorSignals.connect(metaWindow, 'notify::fullscreen', () => update(actor));
    // mutter can replace the surface actor, e.g. when a window is remapped
    actorSignals.connect(actor, 'child-added', () => update(actor));
    actorSignals.connect(actor, 'destroy', () => {
        actorSignals.disconnect(actor);
        actorSignals.disconnect(metaWindow);
        trackedActors.delete(actor);
    });

    update(actor);
}

function refreshAll() {
    trackedActors.forEach(actor => update(actor));
}

/**
 * Returns mutter's surface actor of a window actor. Other extensions may
 * insert their own children, so the child order can't be relied on.
 */
function findSurface(actor) {
    return actor.get_children().find(child =>
        GObject.type_name(child.constructor.$gtype)?.startsWith('MetaSurface')) ?? null;
}

function shouldRound(metaWindow) {
    if (!gsettings.get_boolean('rounded-corners-enabled'))
        return false;
    if (!ROUNDED_TYPES.includes(metaWindow.window_type) || metaWindow.fullscreen)
        return false;

    const wmClasses = gsettings.get_strv('rounded-corners-wm-classes');
    return wmClasses.length === 0 || wmClasses.includes(metaWindow.get_wm_class());
}

function update(actor) {
    const metaWindow = actor.meta_window;
    const surface = findSurface(actor);
    if (!metaWindow || !surface)
        return;

    if (!shouldRound(metaWindow)) {
        removeEffect(actor);
        return;
    }

    let effect = surface.get_effect(EFFECT_NAME);
    if (!effect) {
        // a replaced surface leaves the effect on the old one
        removeEffect(actor);
        effect = new RoundedCornersEffect(metaWindow);
        surface.add_effect_with_name(EFFECT_NAME, effect);
    }
    const insets = gsettings.get_value('rounded-corners-insets').deep_unpack();
    effect.setShape(gsettings.get_int('rounded-corners-radius'),
        insets[metaWindow.get_wm_class()] ?? 0);
}

function removeEffect(actor) {
    actor.get_children().forEach(child => child.remove_effect_by_name(EFFECT_NAME));
}
