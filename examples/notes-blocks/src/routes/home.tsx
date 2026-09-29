import { $component } from "@solidjs/blocks";

const Home = $component(function* Home() {
  return function* () {
    return (
      <div class="note--empty-state">
        <span class="note-text--empty-state">Click a note on the left to view something! 🥺</span>
      </div>
    );
  };
});

export default Home;
