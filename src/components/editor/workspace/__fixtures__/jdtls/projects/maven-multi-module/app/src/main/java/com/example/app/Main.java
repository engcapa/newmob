package com.example.app;

/**
 * Cross-module + ambiguity targets. CoreUtil must arrive from module core;
 * Resu must offer BOTH model.Result twins as distinct candidates.
 */
public class Main {

    public static void main(String[] args) {
        System.out.println(CoreUtil.id("run"));
    }

    void completionTargets() {
        if (false) {
            CoreU
        }
        if (false) {
            Resu
        }
    }
}
