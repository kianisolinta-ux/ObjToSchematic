precision mediump float;

uniform vec3 u_lightWorldPos;
uniform mat4 u_worldViewProjection;
uniform mat4 u_worldInverseTranspose;
uniform vec3 u_cameraDir;

attribute vec3 position;
attribute vec2 texcoord;
attribute vec3 normal;
attribute vec4 colour;

varying vec2 v_texcoord;
varying vec3 v_normal;
varying vec4 v_colour;

void main() {
  v_texcoord = texcoord;
  v_normal = (u_worldInverseTranspose * vec4(normal, 0.0)).xyz;
  v_colour = colour;

  gl_Position = u_worldViewProjection * vec4(position, 1.0);
}
