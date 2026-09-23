import Phaser from 'phaser';

/**
 * @class CameraController
 *
 * Game-style camera controls for the Kingdom Dashboard: mouse-wheel zoom (toward the
 * cursor) and left-button click-drag panning. Pure Phaser input/camera APIs — no extra
 * dependencies.
 *
 * The minimum zoom is dynamic: it's the larger of `minZoom` (an absolute floor) and
 * "fit the world" (viewport size / world bounds size) so the camera can never zoom out
 * past the point where the world stops filling the viewport — which would reveal grey
 * canvas beyond the water. `setBounds()` takes the world rect with NO padding; the
 * caller is expected to pass the exact visible world rect.
 *
 * Usage (from a Scene's create()):
 *   this.cameraController = new CameraController(this, { minZoom: 0.5, maxZoom: 2.5 });
 *   this.cameraController.setBounds(x, y, width, height);
 * And from update():
 *   this.cameraController.update();
 */
class CameraController {
  /**
   * @param {Phaser.Scene} scene
   * @param {Object} [options]
   * @param {number} [options.minZoom=0.5]
   * @param {number} [options.maxZoom=2.5]
   * @param {number} [options.zoomSensitivity=0.0018] - How strongly wheel/pinch deltaY maps to
   *        zoom. Zoom is multiplied by exp(-deltaY * sensitivity), so the response is
   *        PROPORTIONAL to how far you scrolled/pinched (follows trackpad pinch gestures) and
   *        symmetric in/out. A ~100px mouse notch ≈ 16% zoom change.
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    this.camera = scene.cameras.main;

    // ABSOLUTE_MIN is a hard floor on how far out the user can ever zoom, independent of
    // world size. The EFFECTIVE minimum (see recalculateMinZoom()) is always >= this, so
    // the world can never be zoomed out past "fit the viewport" and reveal grey void.
    this.absoluteMinZoom = options.minZoom ?? 0.5;
    this.maxZoom = options.maxZoom ?? 2.5;
    this.zoomSensitivity = options.zoomSensitivity ?? 0.0018;

    // Dynamic "fit the world" zoom floor, recomputed whenever bounds are (re)set or the
    // viewport resizes. Starts equal to the absolute min until real bounds are known.
    this.minZoomToFit = this.absoluteMinZoom;
    this.minZoom = this.absoluteMinZoom;

    // Cached world bounds set via setBounds(), used to recompute minZoomToFit on resize.
    this.boundsX = 0;
    this.boundsY = 0;
    this.boundsWidth = 0;
    this.boundsHeight = 0;

    // Mirrors the live camera zoom; kept in sync so recalculateMinZoom() can re-clamp after
    // bounds/viewport changes. Zoom itself is applied immediately in handleWheel (no easing),
    // so the camera tracks a trackpad pinch 1:1 instead of lagging behind an eased target.
    this.targetZoom = this.camera.zoom;

    // Drag state.
    this.isDragging = false;
    this.dragStartPointerX = 0;
    this.dragStartPointerY = 0;
    this.dragStartScrollX = 0;
    this.dragStartScrollY = 0;

    this._onWheel = this.handleWheel.bind(this);
    this._onPointerDown = this.handlePointerDown.bind(this);
    this._onPointerMove = this.handlePointerMove.bind(this);
    this._onPointerUp = this.handlePointerUp.bind(this);
    this._onResize = this.handleResize.bind(this);

    scene.input.on('wheel', this._onWheel);
    scene.input.on('pointerdown', this._onPointerDown);
    scene.input.on('pointermove', this._onPointerMove);
    scene.input.on('pointerup', this._onPointerUp);
    scene.input.on('pointerout', this._onPointerUp);
    scene.scale?.on('resize', this._onResize);

    // Clean up listeners if the scene shuts down without an explicit destroy() call.
    scene.events.once('shutdown', () => this.destroy());
    scene.events.once('destroy', () => this.destroy());
  }

  /**
   * Sets camera scroll bounds to EXACTLY the given world rect — no padding. Bounds are
   * expected to match the visible world/water rect precisely, so the camera can never
   * scroll or zoom out to reveal grey canvas beyond it. Call again after a resize or
   * layout rebuild to keep bounds (and the zoom-to-fit floor) in sync.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  setBounds(x, y, width, height) {
    this.boundsX = x;
    this.boundsY = y;
    this.boundsWidth = width;
    this.boundsHeight = height;

    this.camera.setBounds(x, y, width, height);
    this.recalculateMinZoom();
  }

  /**
   * Recomputes minZoomToFit — the zoom level at which the world rect exactly fills the
   * viewport — from the cached bounds and current viewport size, then re-clamps the
   * effective minimum zoom and snaps targetZoom/camera.zoom up if they're now below it.
   *
   * @private
   */
  recalculateMinZoom() {
    if (this.boundsWidth <= 0 || this.boundsHeight <= 0) return;

    const viewportWidth = this.scene?.scale?.width ?? this.camera.width;
    const viewportHeight = this.scene?.scale?.height ?? this.camera.height;

    const minZoomToFit = Math.max(
      viewportWidth / this.boundsWidth,
      viewportHeight / this.boundsHeight
    );

    this.minZoomToFit = minZoomToFit;
    // Never allow zooming out past "fit" — the effective min is whichever is LARGER.
    this.minZoom = Math.max(minZoomToFit, this.absoluteMinZoom);

    // If the world got relatively bigger (or the viewport shrank), the previous zoom may
    // now be below the new floor. Snap both target and actual zoom up immediately.
    if (this.targetZoom < this.minZoom) {
      this.targetZoom = this.minZoom;
    }
    if (this.camera.zoom < this.minZoom) {
      this.camera.zoom = this.minZoom;
    }
  }

  /**
   * Scene resize handler — the viewport size changed, so the "fit the world" zoom floor
   * may have changed even if bounds themselves didn't. The scene also re-calls setBounds()
   * on resize/layout rebuild, but this covers resize events that fire independently of that.
   *
   * @private
   */
  handleResize() {
    this.recalculateMinZoom();
  }

  /**
   * Zooms in/out under the cursor, immediately. The zoom factor is PROPORTIONAL to the
   * wheel/pinch deltaY (exp(-deltaY * sensitivity)), so a hard trackpad pinch zooms more than
   * a gentle one and the motion follows the gesture instead of snapping a fixed step. The world
   * point under the cursor is captured before the zoom change and re-anchored after, keeping
   * whatever is under the pointer fixed on screen.
   *
   * @private
   */
  handleWheel(pointer, gameObjects, deltaX, deltaY) {
    const prevZoom = this.camera.zoom;
    // Multiplicative + exponential: symmetric in/out and framerate-independent. Pinch gestures
    // stream many small-deltaY events, each nudging zoom a little → smooth, gesture-tracking.
    const factor = Math.exp(-deltaY * this.zoomSensitivity);
    const nextZoom = Phaser.Math.Clamp(
      prevZoom * factor,
      this.minZoom, // dynamic "fit the world" floor (see recalculateMinZoom())
      this.maxZoom
    );

    if (nextZoom === prevZoom) return;

    // Capture the world point under the cursor BEFORE zooming...
    const before = this.camera.getWorldPoint(pointer.x, pointer.y);
    this.camera.setZoom(nextZoom);
    // ...then re-derive it after and shift scroll so it stays under the cursor.
    const after = this.camera.getWorldPoint(pointer.x, pointer.y);
    this.camera.scrollX += before.x - after.x;
    this.camera.scrollY += before.y - after.y;

    this.targetZoom = nextZoom;
  }

  /**
   * @private
   */
  handlePointerDown(pointer) {
    if (!pointer.leftButtonDown()) return;

    this.isDragging = true;
    this.dragStartPointerX = pointer.x;
    this.dragStartPointerY = pointer.y;
    this.dragStartScrollX = this.camera.scrollX;
    this.dragStartScrollY = this.camera.scrollY;

    if (this.scene.input.manager?.canvas) {
      this.scene.input.manager.canvas.style.cursor = 'grabbing';
    }
  }

  /**
   * @private
   */
  handlePointerMove(pointer) {
    if (!this.isDragging || !pointer.leftButtonDown()) return;

    // Divide by zoom — a screen-pixel drag corresponds to fewer world pixels when zoomed in,
    // and more when zoomed out. Without this the map over-scrolls at non-1x zoom.
    const zoom = this.camera.zoom || 1;
    const dx = (pointer.x - this.dragStartPointerX) / zoom;
    const dy = (pointer.y - this.dragStartPointerY) / zoom;

    this.camera.scrollX = this.dragStartScrollX - dx;
    this.camera.scrollY = this.dragStartScrollY - dy;
  }

  /**
   * @private
   */
  handlePointerUp() {
    if (!this.isDragging) return;
    this.isDragging = false;

    if (this.scene.input.manager?.canvas) {
      this.scene.input.manager.canvas.style.cursor = 'default';
    }
  }

  /**
   * Called every frame from the scene's update(). Zoom is applied immediately in handleWheel,
   * so this only enforces the dynamic min-zoom floor (which can change when bounds/viewport
   * change) — snapping the camera back up if it somehow sits below "fit the world".
   */
  update() {
    if (this.camera.zoom < this.minZoom) {
      this.camera.setZoom(this.minZoom);
      this.targetZoom = this.minZoom;
    } else if (this.camera.zoom > this.maxZoom) {
      this.camera.setZoom(this.maxZoom);
      this.targetZoom = this.maxZoom;
    }
  }

  /**
   * Removes all input listeners. Safe to call multiple times.
   */
  destroy() {
    if (!this.scene) return;
    this.scene.input.off('wheel', this._onWheel);
    this.scene.input.off('pointerdown', this._onPointerDown);
    this.scene.input.off('pointermove', this._onPointerMove);
    this.scene.input.off('pointerup', this._onPointerUp);
    this.scene.input.off('pointerout', this._onPointerUp);
    this.scene.scale?.off('resize', this._onResize);
    this.scene = null;
  }
}

export default CameraController;
