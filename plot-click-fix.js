/* Three Intelligences Explorer: fast country selection patch.
   Prevents Plotly from fully re-rendering the 3D cube on every point click.
   The previous selectRow() implementation updated the profile and then called
   renderPlot(), which made country switching slow and could leave the plot in
   a non-responsive state until a hard refresh. */

(function installFastSelectionPatch() {
  function patch() {
    if (typeof selectRow !== "function") {
      window.setTimeout(patch, 30);
      return;
    }

    if (typeof state === "undefined") {
      window.setTimeout(patch, 30);
      return;
    }

    selectRow = function selectRowWithoutPlotRerender(row) {
      const enriched = typeof enrichTheoryFields === "function"
        ? enrichTheoryFields(row)
        : row;

      state.selectedRow = enriched;

      if (typeof renderSelectedCountry === "function") renderSelectedCountry(enriched);
      if (typeof renderSelectedTheory === "function") renderSelectedTheory(enriched);
      if (typeof renderTransitionLean === "function") renderTransitionLean(enriched);
      if (typeof updateReportCta === "function") updateReportCta();

      // Deliberately no renderPlot() here.
      // Filters, camera reset, and visual-layer toggles still re-render the plot.
      // Country clicks only update the side/report panels, keeping Plotly responsive.
    };

    window.threeIntelligencesFastSelectionPatch = true;
  }

  patch();
})();
