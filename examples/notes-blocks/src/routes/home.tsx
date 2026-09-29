import { $component } from "solid-js";

const Home = $component(function* () {
  return function* () {
    return (
      <div class="note--empty-state">
        <span class="note-text--empty-state">Click a note on the left to view something! 🥺</span>
      </div>
    );
  };
});

export default Home;
