// Groking Animation using D3.js
// This script creates an animated text effect representing "groking" or sudden understanding.
// Assumes D3.js is loaded (e.g., via <script src="https://d3js.org/d3.v7.min.js"></script>)

const svg = d3.select("body")
  .append("svg")
  .attr("width", 800)
  .attr("height", 400)
  .style("background-color", "#f0f0f0");

// Initial text setup
const text = svg.append("text")
  .attr("x", 400)
  .attr("y", 200)
  .attr("text-anchor", "middle")
  .style("font-family", "Arial")
  .style("font-size", "24px")
  .style("fill", "gray")
  .text("Thinking...");

// Animate to "Groking!" with transitions
text.transition()
  .delay(1000)
  .duration(1000)
  .style("font-size", "48px")
  .style("fill", "blue")
  .text("Groking!")
  .end()
  .then(() => {
    // Add a pulsing effect for insight
    text.transition()
      .duration(500)
      .style("fill", "orange")
      .transition()
      .duration(500)
      .style("fill", "red")
      .transition()
      .duration(500)
      .style("fill", "blue");
  });

// Optional: Add animated circles representing ideas popping
const circles = svg.selectAll("circle")
  .data([1, 2, 3, 4, 5])
  .enter()
  .append("circle")
  .attr("cx", (d, i) => 200 + i * 80)
  .attr("cy", 300)
  .attr("r", 0)
  .style("fill", "lightblue");

circles.transition()
  .delay((d, i) => 2000 + i * 200)
  .duration(500)
  .attr("r", 20)
  .style("fill", "yellow");