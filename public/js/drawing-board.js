// お絵描き用キャンバス（マウス・タッチ・ペン対応）
class DrawingBoard {
  static COLORS = ['#222222', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#8d6e63', '#f48fb1'];
  static WIDTHS = [4, 10, 24];
  static BACKGROUND = '#ffffff';

  constructor(canvas, { palette, widthPicker, eraserButton, undoButton, clearButton }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.color = DrawingBoard.COLORS[0];
    this.width = DrawingBoard.WIDTHS[0];
    this.erasing = false;
    this.enabled = true;

    this.colorButtons = DrawingBoard.COLORS.map((color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.background = color;
      button.setAttribute('aria-label', `色 ${color}`);
      button.addEventListener('click', () => {
        this.color = color;
        this.erasing = false;
        this.updateToolUi();
      });
      palette.append(button);
      return { button, color };
    });

    this.widthButtons = DrawingBoard.WIDTHS.map((width) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'width-option';
      button.setAttribute('aria-label', `太さ ${width}`);
      const dot = document.createElement('span');
      dot.style.width = dot.style.height = `${Math.max(4, width / 1.5)}px`;
      button.append(dot);
      button.addEventListener('click', () => {
        this.width = width;
        this.updateToolUi();
      });
      widthPicker.append(button);
      return { button, width };
    });

    this.eraserButton = eraserButton;
    eraserButton.addEventListener('click', () => {
      this.erasing = !this.erasing;
      this.updateToolUi();
    });
    undoButton.addEventListener('click', () => {
      this.strokes.pop();
      this.redraw();
    });
    clearButton.addEventListener('click', () => {
      this.strokes = [];
      this.redraw();
    });

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', () => this.onUp());
    canvas.addEventListener('pointercancel', () => this.onUp());

    this.updateToolUi();
    this.redraw();
  }

  reset() {
    this.strokes = [];
    this.current = null;
    this.redraw();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.onUp();
  }

  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }

  updateToolUi() {
    for (const { button, color } of this.colorButtons) {
      button.classList.toggle('selected', !this.erasing && color === this.color);
    }
    for (const { button, width } of this.widthButtons) {
      button.classList.toggle('selected', width === this.width);
    }
    this.eraserButton.classList.toggle('selected', this.erasing);
  }

  pointFrom(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  onDown(e) {
    if (!this.enabled || this.current) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.current = {
      color: this.erasing ? DrawingBoard.BACKGROUND : this.color,
      width: this.erasing ? this.width * 2 : this.width,
      points: [this.pointFrom(e)],
    };
    this.strokes.push(this.current);
    this.drawStroke(this.current);
  }

  onMove(e) {
    if (!this.current) return;
    e.preventDefault();
    const points = this.current.points;
    points.push(this.pointFrom(e));
    this.drawSegment(this.current, points[points.length - 2], points[points.length - 1]);
  }

  onUp() {
    this.current = null;
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.fillStyle = DrawingBoard.BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of this.strokes) this.drawStroke(stroke);
  }

  drawStroke(stroke) {
    const [first, ...rest] = stroke.points;
    // タップしただけのときも点が描かれるようにする
    this.ctx.fillStyle = stroke.color;
    this.ctx.beginPath();
    this.ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    this.ctx.fill();
    let prev = first;
    for (const point of rest) {
      this.drawSegment(stroke, prev, point);
      prev = point;
    }
  }

  drawSegment(stroke, from, to) {
    const { ctx } = this;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
}
