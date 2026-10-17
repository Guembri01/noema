import { Composition } from 'remotion';
import { FILM_TOTAL, NoemaFilm } from './noema/Main';

export const Root: React.FC = () => (
  <Composition
    id="NoemaPromo"
    component={NoemaFilm}
    durationInFrames={FILM_TOTAL}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ bgm: true }}
  />
);
