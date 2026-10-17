import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
// Frames are JPEG rather than PNG because the film is 4,000+ frames and PNG
// frames make the render several times slower for no visible gain. The quality
// is turned up instead: the whole film is small UI text, which is exactly what a
// default-quality JPEG smears.
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('angle');
Config.setConcurrency(4);
