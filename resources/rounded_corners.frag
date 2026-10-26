// Rounded corners shader, used by roundedcorners.js.
//
// Adapted from Rounded Window Corners Reborn (GPL-3.0):
// https://github.com/flexagoon/rounded-window-corners
// which in turn is based on mutter's meta-background-content.c.

// Visible window area in actor pixels: x1, y1, x2, y2
uniform vec4 bounds;
uniform float clipRadius;
// 1 / actor size, converts texture coordinates to pixels
uniform vec2 pixelStep;

float circleBounds(vec2 p, vec2 center, float clipRadius) {
    vec2 delta = p - center;
    float distSquared = dot(delta, delta);

    float outerRadius = clipRadius + 0.5;
    if (distSquared >= (outerRadius * outerRadius))
        return 0.0;

    float innerRadius = clipRadius - 0.5;
    if (distSquared <= (innerRadius * innerRadius))
        return 1.0;

    // antialias the edge
    return outerRadius - sqrt(distSquared);
}

float getPointOpacity(vec2 p, vec4 bounds, float clipRadius) {
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w)
        return 0.0;

    vec2 center;

    float centerLeft = bounds.x + clipRadius;
    float centerRight = bounds.z - clipRadius;
    if (p.x < centerLeft)
        center.x = centerLeft;
    else if (p.x > centerRight)
        center.x = centerRight;
    else
        return 1.0;

    float centerTop = bounds.y + clipRadius;
    float centerBottom = bounds.w - clipRadius;
    if (p.y < centerTop)
        center.y = centerTop;
    else if (p.y > centerBottom)
        center.y = centerBottom;
    else
        return 1.0;

    return circleBounds(p, center, clipRadius);
}

void main() {
    vec2 p = cogl_tex_coord0_in.xy / pixelStep;
    cogl_color_out *= getPointOpacity(p, bounds, clipRadius);
}
