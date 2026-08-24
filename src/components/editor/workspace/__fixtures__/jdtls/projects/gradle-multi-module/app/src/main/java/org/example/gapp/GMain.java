package org.example.gapp;

/**
 * Cross-module target: no import yet — resolving the GCo completion must
 * deliver the org.example.gcore.GCore import as an additionalTextEdits edit.
 */
public class GMain {

    public static void main(String[] args) {
        System.out.println(GCore.label());
    }

    void completionTargets() {
        if (false) {
            GCo
        }
    }
}
